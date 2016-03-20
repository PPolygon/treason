/*
 * Copyright 2015 Christopher Brown
 *
 * This work is licensed under the Creative Commons Attribution-NonCommercial 4.0 International License.
 *
 * To view a copy of this license, visit http://creativecommons.org/licenses/by-nc/4.0/ or send a letter to:
 *     Creative Commons
 *     PO Box 1866
 *     Mountain View
 *     CA 94042
 *     USA
 */
'use strict';

var fs = require('fs');
var rand = require('random-seed')();

var argv = require('optimist')
    .usage('$0 [--debug] [--port <port>] [--log <logfile>]')
    .default('port', process.env.PORT)
    .default('log', 'treason.log')
    .argv;

var winston = require('winston');
winston.add(winston.transports.File, {
    filename: argv.log,
    maxsize: 5*1024*1024,
    zippedArchive: true,
    json: false
});
winston.remove(winston.transports.Console);
winston.info('server started');

var express = require('express');
var app = express();
app.set('views', __dirname + '/views');
app.use(express.static(__dirname + '/web'));

var version = require('./version');
app.get('/version.js', version);

app.get('/', function (req, res) {
    res.render('pages/index.ejs');
});

var server = app.listen(argv.port);

var io = require('socket.io')(server);
var createGame = require('./game');
var createNetPlayer = require('./net-player');

var publicGames = [];
var privateGames = {};
var pending = [];
var sockets = {};
var TIMEOUT = 30 * 60 * 1000;

io.on('connection', function (socket) {
    var timestamp = new Date().getTime();
    sockets[socket.id] = timestamp;
    var activeUsers = 0;
    for (var id in sockets) {
        if (timestamp - sockets[id] > TIMEOUT) {
            delete sockets[id];
        } else {
            activeUsers++;
        }
    }
    socket.emit('hello', {
        activeUsers: activeUsers
    });

    socket.on('join', function (data) {
        var playerName = data.playerName;
        var gameName = data.gameName;

        if (isInvalidPlayerName(playerName)) {
            return;
        }
        if (gameName) {
            joinPrivateGame(playerName, gameName);
        } else {
            joinOrCreatePublicGame(playerName);
        }
    });

    function joinPrivateGame(playerName, gameName) {
        var game = privateGames[gameName];
        if (!game) {
            game = createPrivateGame(gameName);
        }
        if (!game.canJoin()) {
            socket.emit('gameinprogress', {
                gameName: gameName
            });
            return;
        }
        createNetPlayer(game, socket, playerName);
    }

    function joinOrCreatePublicGame(playerName) {
        var game = null;
        while (!game) {
            if (publicGames.length) {
                game = publicGames.pop();
                if (!game.canJoin()) {
                    game = null;
                }
            } else {
                game = createGame({
                    debug: argv.debug,
                    logger: winston,
                    moveDelay: 3000, // For AI players
                    moveDelaySpread: 700
                });
            }
        }
        createNetPlayer(game, socket, playerName);
        if (game.canJoin()) {
            // The game is not yet full; still open for more players.
            publicGames.push(game);
        }
    }

    function createPrivateGame(gameName) {
        var game = createGame({
            debug: argv.debug,
            logger: winston,
            moveDelay: 1000,
            gameName: gameName,
            created: new Date()
        });
        privateGames[gameName] = game;
        game.once('end', function () {
            delete privateGames[gameName];
        });
        return game;
    }

    socket.on('create', function(data) {
        var gameName = randomGameName(data.gameName);
        if (isInvalidPlayerName(data.playerName)) {
            return;
        }
        var game = createPrivateGame(gameName);
        socket.emit('created', {
            gameName: gameName
        });
    });

    socket.on('disconnect', function () {
        delete sockets[socket.id];
        socket.removeAllListeners();
        socket = null;
    })
});

var adjectives;

fs.readFile(__dirname + '/adjectives.txt', function(err, data) {
    if (err) {
        throw err;
    }
    adjectives = data.toString().split(/\r?\n/);
});

function isInvalidPlayerName(playerName) {
    return !playerName || playerName.length > 30 || !playerName.match(/^[a-zA-Z0-9_ !@#$*]+$/);
}

function randomGameName(playerName) {
    var i = 1;
    while (true) {
        var adjective = adjectives[rand(adjectives.length)];
        var gameName =  playerName + "'s " + adjective + " game";
        if (i > 100) {
            gameName += " (" + i + ")";
        }
        if (!privateGames[gameName]) {
            return gameName;
        }
        i++;
    }
}
