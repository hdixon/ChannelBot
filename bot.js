var reddit = require("reddit-api"),
    chalk = require("chalk"),
    yaml = require("js-yaml"),
    fs = require("fs"),
    figures = require("figures"),
    storage = require("./storage"),
    youtube = require("youtube-get"),
    log = require("./log"),
    validate = require("validate-obj"),
    version = "ChannelBot 2.0",
    redditurl = "http://www.reddit.com",
    config, modhash;

init = function () {

    validators();

    process.stdout.write(chalk.bold.dim(version) + "\n");
    process.stdout.write(chalk.dim("By Jari Zwarts") + "\n\n");

    try {
        //start the init

        log.loading("configuration");
        config = log.config = yaml.safeLoad(fs.readFileSync("config.yaml", "utf-8"));
        log.loadingOK();

        log.loading("storage");
        storage = new storage();
        log.loadingOK();

        log.loading("youtube");
        youtube = new youtube(config.yt_key);
        log.loadingOK();

        log.loading("reddit");
        reddit = new reddit(version);
        reddit.account.login(config.username, config.password, function(error, data) {
            checkmodhash(data);
            if(error) log.loadingFail(error);
            else {
                log.loadingOK();

                //all systems go
                monitor.start();
            }
        });
    } catch (e) {
        log.loadingFail(e);
    }
};

/**
 * validators provides some extra validation functions that validate-obj doesn't have
 */
validators = function() {
    validate.register("isAlphaNum", validate.build(function(value, params) {
        if(params && params[0]) var additional = params[0];
        else additional = "";

        var reg = new RegExp("^[a-zA-Z0-9"+additional+"]+$")
        return /^[a-zA-Z0-9]+$/.test(value);
    }, function(name) {
        return name + " must be a alphanumeric string"
    }));
}

/**
 * monitor monitors for incoming PM's, uploads
 */
monitor = {
    start: function () {
        setInterval(this.pms, 2500) || this.pms();
        setInterval(this.videos, 2500) || this.videos();
    },

    pms: function () {
        try {
            var unread = reddit.messages.get('unread', function(err, data) {
                checkmodhash(data);
                if(err) {
                    log.error("Can't get unread messages", err);
                    return;
                }
                var keys = Object.keys(data);
                keys.length && keys.forEach(function (key) {
                    var pm = data[key];
                    //handle pm
                    handler.PM(pm.data);
                })
            });
        } catch(e) {
            log.error("Error in monitor.pm thread", e);
        }
    },

    videos: function() {
        storage.getAll().forEach(function (channel, index) {
            youtube("playlistItems", {
                playlistId: channel.upload_playlist,
                part: 'id, snippet, contentDetails, status'
            }, function (error, data) {
                if(error) log.error("Failed to get data for channel '{0}'".format(channel.channel), error)
                else {
                    if(!('last_videos' in channel)) channel.last_videos = [];

                    data.items.forEach(function(video) {
                        var vid = video.contentDetails.videoId;
                        if(channel.last_videos.indexOf(vid) == -1) {
                            //we've got one!

                            //was this video published after registering this channel to CB?
                            if(Math.round(new Date(video.snippet.publishedAt) / 1000) < channel.register_date) {
                                return;
                            }

                            reddit.links.submit({
                                subreddit: channel.subreddit,
                                subject: video.snippet.title,
                                url: config.prepend + video.contentDetails.videoId,
                                modhash: modhash
                            }, function(data, error) {
                                checkmodhash(data);
                                if(error) {
                                    log.warn("Failed to submit \"{0}\", trying again later.".format(video.snippet.title), error);
                                    return
                                } else {
                                    log.info("Submitted \"{0}\" from \"{1}\" to /r/{2}".format(video.snippet.title, channel.channel, channel.subreddit));
                                }
                            });
                        }
                        channel.last_check = Math.round(new Date() / 1000);
                        storage.set(index, channel);
                    });
                }
            });
        })
    }
};

/**
 * todo api should keep track of this, @michaelowens pls
 */
var checkmodhash = function(data) {
    try {
        if(!data) return;
        if(typeof data == "string") modhash = data;
        else if(typeof data.modhash == "string") modhash = data.modhash;
    } catch(e) {}
}

var checker = {
    isMod: function(subreddit, author, callback) {
        reddit._get("/r/{0}/about/moderators.json".format(subreddit), {}, {} , function(err, data) {
            if(err) callback(err);

            try {
                var yes = false;
                data.body.data.children.forEach(function(user) {
                    if(user.name.toLowerCase() === author.toLowerCase()) {
                        if(user.mod_permissions.indexOf("all") !== -1) yes = true;
                    }
                });
                if(!yes) callback(new Error("You're not a moderator of this subreddit (with full permissions)"))
                else callback(null);
            } catch(e) {
                callback(err);
            }
        });
    },

    channelExists: function(channel, isId, callback) {
        var params = {
            part: 'id,snippet,contentDetails'
        };
        if(isId) params.id = channel;
        else params.forUsername = channel;

        youtube("channels", params, callback);
    },

    channelAlreadyExistsInStorage: function(channel_id) {
        return storage.getAll().some(function(row) {
            return row.channel_id == channel_id;
        });
    }
};

/**
 * handler processes actions the monitor picks up
 */
handler = {
    PMshandled: [],
    PM: function(pm) {

        var markReadAndRespond = function(subject, message, success) {
            log.info("Responded with '"+subject+"'")
            reddit.messages.compose("", "", subject, (!success ? "**✖** " : "**✔** ") + message, pm.author, modhash, checkmodhash);
            reddit.messages.read(pm.name, modhash, checkmodhash);
        };

        try {
            if(this.PMshandled.indexOf(pm.name) != -1) return;
            else this.PMshandled.push(pm.name);
            if(pm.was_comment) {
                log.debug("Ignored a comment reply from "+pm.author);
                reddit.messages.read(pm.name, modhash, checkmodhash);
                return;
            }

            log.info("Got a message from '{0}' with the subject '{1}'!".format(pm.author, pm.subject));

            log.debug("\n----------------\n{0}\n----------------".format(pm.body));
            log.debug("Processing message:")
            log.debug(figures.pointer+" Parsing...");

            //parse contents
            try {
                var message = yaml.safeLoad(pm.body);
                if(validate.hasErrors(message, validate.isObject)) throw "YAML didn't return a object";
            } catch(e) {
                log.warn(e.toString());
                markReadAndRespond("Unable to parse your message", "Your message contains invalid YAML. For more info, read the [API docs](http://www.reddit.com/r/ChannelBot/wiki/api) and [YAML formatting](https://en.wikipedia.org/wiki/YAML)");
                return;
            }

            switch(pm.subject.toLowerCase()) {
                case "add":
                    //validate inputs
                    log.debug(figures.pointer+" Validating fields");

                    var validation = {
                        subreddit: [validate.required, validate.isString, validate.minLength([1]), validate.isAlphaNum(["_"])],
                        channel_id: [validate.isString, validate.minLength([24]), validate.maxLength([24]), validate.isAlphaNum(["_-"])],
                        channel: [validate.isString, validate.minLength([1]), validate.isAlphaNum],

                        selfCrossValidators: function(message) {
                            if(!"channel" in message && !"channel_id" in message) return "Please provide either 'channel' or 'channel_id'"
                        }
                    };

                    var errors = validate.hasErrors(message, validation, 'message');
                    if(errors) {
                        var reply = "The following error{0} occurred while validating your message: \n\n".format(errors.length > 1 ? "s" : "");
                        errors.forEach(function(error) {
                            reply += "\n\n- {0}\n\n".format(error);
                        });
                        reply += "\n\nDon't forget to read the [docs](http://www.reddit.com/r/ChannelBot/wiki/api)";
                        markReadAndRespond("Unable to add channel", reply);
                        return;
                    }

                    //check if author is mod of sub
                    log.debug(figures.pointer+" Checking if user is mod...");
                    checker.isMod(message.subreddit, pm.author, function(error) {
                        if(error) {
                            log.warn("Mod check not succeeded", error.toString())
                            markReadAndRespond("Mod check failed", error.toString());
                        } else {
                            //check if channel exists
                            log.debug(figures.pointer+" Checking if provided channel is valid");
                            checker.channelExists(message.channel_id ? message.channel_id : message.channel, !!message.channel_id, function(error, data) {
                                if(error) {
                                    log.warn("Youtube check did not succeed", error.toString())
                                    markReadAndRespond("The check if your channel is valid has failed.", error.toString());
                                } else {
                                    try {
                                        data = data.items[0];
                                        message.channel_id = data.id;
                                        message.channel = data.snippet.title;
                                        message.upload_playlist = data.contentDetails.relatedPlaylists.uploads;
                                    } catch(e) {
                                        markReadAndRespond(
                                            "Could not get channel details.",
                                            "Check if your uploads are accessible to everyone and if you didn't misspell the channel (id)."
                                        );
                                        return;
                                    }

                                    //check if combination already exists in storage
                                    if(!checker.channelAlreadyExistsInStorage(message.channel_id)) {

                                        storage.push({
                                            "channel": message.channel,
                                            "channel_id": message.channel_id,
                                            "subreddit": message.subreddit,
                                            "user": pm.author,
                                            //yea, epoch because we need to conform to the old format
                                            "register_date": Math.floor(new Date() / 1000),
                                            "upload_playlist": message.upload_playlist
                                        });
                                        markReadAndRespond(
                                            "Successfully added {0}.".format(message.channel),
                                            message.channel+" was added and will now be monitored for new uploads.",
                                            true
                                        );
                                    } else markReadAndRespond(
                                        "This channel is already added to this subreddit.",
                                        "This channel+subreddit combination is already added."
                                    )

                                }
                            });
                        }
                    });

                    break;
                default:
                    markReadAndRespond("Invalid subject.", "Subject needs to be one of the following:\n\n'add', 'list' OR 'remove'.")
                    break;
            }
        } catch(e) {
            log.error("Error while processing PM!", e);
            markReadAndRespond("Internal error", "Couldn't process your message because of a internal error. Please contact the administrator of this bot.");
        }
    }
}

String.prototype.format = function() {
    var args = arguments;
    return this.replace(/{(\d+)}/g, function(match, number) {
        return typeof args[number] != 'undefined' ? args[number] : match
    });
};


init();