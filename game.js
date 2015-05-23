'use strict';

var shared = require('./web/shared.js');
var actions = shared.actions;

var stateNames = {
    WAITING_FOR_PLAYERS: 'waiting-for-players',
    START_OF_TURN: 'start-of-turn',
    ACTION_RESPONSE: 'action-response',
    BLOCK_RESPONSE: 'block-response',
    REVEAL_INFLUENCE: 'reveal-influence',
    EXCHANGE: 'exchange'
};

var deepcopy = require('deepcopy');

var nextGameId = 1;
var nextPlayerId = 1;

module.exports = function createGame() {
    var gameId = nextGameId++;
    var numPlayers = 2;

    var state = {
        stateId: 1,
        gameId: gameId,
        players: [],
        numPlayers: numPlayers,
        state: createState(stateNames.WAITING_FOR_PLAYERS),
        history: []
    };

    var sockets = [];

    var deck = shuffle(buildDeck());

    function playerJoined(socket) {
        var playerId = nextPlayerId++;

        if (state.players.length >= numPlayers) {
            socket.emit('error', 'Cannot join game ' + gameId + ': it is full.');
            return;
        }

        var player = {
            playerId: playerId,
            name: 'Player ' + playerId,
            cash: 2,
            influence: [
                {
                    role: deck.pop(),
                    revealed: false
                },
                {
                    role: deck.pop(),
                    revealed: false
                },
            ]
        };
        state.players.push(player);
        sockets.push(socket);

        if (isActive()) {
            state.state = createState(stateNames.START_OF_TURN, 0);
        }

        addHistory(state.players.length - 1, 'joined the game');
        emitState();
    }

    function playerLeft(socket) {
        var playerIdx = playerIdxBySocket(socket);
        if (playerIdx == null) {
            debug('unknown player disconnected');
            return;
        }
        sockets[playerIdx] = null;
        killPlayer(playerIdx);
        addHistory(playerIdx, 'left the game');
        emitState();
    }

    function killPlayer(playerIdx) {
        // Reveal all the player's influence.
        var influence = state.players[playerIdx].influence;
        for (var j = 0; j < influence.length; j++) {
            influence[j].revealed = true;
        }

        if (state.state.playerIdx == playerIdx) {
            nextTurn();
        }

        checkForGameEnd();
    }

    function playerIdxBySocket(socket) {
        for (var i = 0; i < state.players.length; i++) {
            if (sockets[i] == socket) {
                return i;
            }
        }
        return null;
    }

    function checkForGameEnd() {
        var winnerIdx = null;
        for (var i = 0; i < state.players.length; i++) {
            if (countInfluence(state.players[i])) {
                if (winnerIdx == null) {
                    winnerIdx = i;
                } else {
                    winnerIdx = null;
                    break;
                }
            }
        }
        if (winnerIdx != null) {
            state.state = createState('game-won', winnerIdx);
        }
    }

    function countInfluence(player) {
        var count = 0;
        for (var i = 0; i < player.influence.length; i++) {
            if (!player.influence[i].revealed) {
                count++;
            }
        }
        return count;
    }

    function emitState() {
        state.stateId++;
        debug(state);
        for (var i = 0; i < state.players.length; i++) {
            var masked = maskState(i);
            if (sockets[i] != null) {
                sockets[i].emit('state', masked);
            }
        }
    }

    /**
     * Mask hidden influences, add player-specific data.
     */
    function maskState(playerIdx) {
        var masked = deepcopy(state);
        for (var i = 0; i < state.players.length; i++) {
            if (i != playerIdx) {
                var influence = masked.players[i].influence;
                for (var j = 0; j < influence.length; j++) {
                    if (!influence[j].revealed) {
                        influence[j].role = 'Unknown';
                    }
                }
            }
        }
        masked.playerIdx = playerIdx;
        masked.playerId = masked.players[playerIdx].playerId;
        return masked;
    }

    function isActive() {
        return state.players.length == numPlayers;
    }

    function command(socket, command) {
        debug(command);
        var i;
        var playerIdx = playerIdxBySocket(socket);
        if (playerIdx == null) {
            debug('unknown player');
            return;
        }
        debug('from: ' + playerIdx);
        var player = state.players[playerIdx];
        if (player == null) {
            debug('unknown player');
            return;
        }
        if (command.stateId != state.stateId) {
            debug('stale state');
            return;
        }

        if (command.command == 'play-action') {
            if (state.state.name != stateNames.START_OF_TURN) {
                debug('incorrect state');
                return;
            }
            if (state.state.playerIdx != playerIdx) {
                debug('not your turn');
                return;
            }
            var action = actions[command.action];
            if (action == null) {
                debug('unknown action');
                return;
            }
            if (player.cash >= 10 && command.action != 'coup') {
                debug('you must coup with >= 10 cash');
                return;
            }
            if (player.cash < action.cost) {
                debug('not enough cash');
                return;
            }
            if (action.targetted) {
                if (command.target == null) {
                    debug('no target specified');
                    return;
                }
                if (command.target < 0 || command.target >= numPlayers) {
                    debug('invalid target specified');
                    return;
                }
                if (!countInfluence(state.players[command.target])) {
                    debug('cannot target dead player');
                    return;
                }
            }
            player.cash -= action.cost;
            if (action.role == null && action.blockedBy == null) {
                if (playAction(playerIdx, command)) {
                    nextTurn();
                }
            } else {
                debug('checking for blocks/challenges');
                if (command.action == 'steal') {
                    addHistory(playerIdx, 'attempted to steal from', command.target);
                } else if (command.action == 'assassinate') {
                    addHistory(playerIdx, 'attempted to assassinate', command.target);
                } else if (command.action == 'exchange') {
                    addHistory(playerIdx, 'attempted to exchange');
                } else {
                    addHistory(playerIdx, 'attempted to draw ' + command.action);
                }
                state.state = createState(stateNames.ACTION_RESPONSE, playerIdx, command.action, command.target);
            }

        } else if (command.command == 'challenge') {
            if (state.state.name == stateNames.ACTION_RESPONSE) {
                if (playerIdx == state.state.playerIdx) {
                    debug('cannot challenge your own action');
                    return;
                }
                var action = actions[state.state.action];
                if (!action) {
                    debug('unknown action');
                    return;
                }
                if (!action.role) {
                    debug('action cannot be challenged');
                    return;
                }
                challenge(playerIdx, state.state.playerIdx, action.role);

            } else if (state.state.name == stateNames.BLOCK_RESPONSE) {
                if (playerIdx == state.state.target) {
                    debug('cannot challenge your own block');
                    return;
                }
                challenge(playerIdx, state.state.target, state.state.role);

            } else {
                debug('incorrect state');
                return;
            }

        } else if (command.command == 'reveal') {
            if (state.state.name != stateNames.REVEAL_INFLUENCE) {
                debug('incorrect state');
                return;
            }
            if (state.state.target != playerIdx) {
                debug('not your turn to reveal an influence');
                return;
            }
            for (i = 0; i < player.influence.length; i++) {
                var influence = player.influence[i];
                if (influence.role == command.role && !influence.revealed) {
                    influence.revealed = true;
                    addHistory(playerIdx, 'revealed ' + command.role);
                    if (state.state.action == 'exchange' && state.state.target != state.state.playerIdx) {
                        // If the challenge was for an exchange, and the challenge was lost, the exchange must place after the reveal.
                        playAction(state.state.playerIdx, state.state);
                    } else {
                        nextTurn();
                    }
                    emitState();
                    return;
                }
            }
            debug('could not reveal role');
            return;

        } else if (command.command == 'block') {
            if (state.state.name != stateNames.ACTION_RESPONSE) {
                debug('incorrect state');
                return;
            }
            var action = actions[state.state.action];
            if (!action) {
                debug('unknown action');
                return;
            }
            if (playerIdx == state.state.playerIdx) {
                debug('cannot block your own action');
                return;
            }
            if (!action.blockedBy) {
                debug('action cannot be blocked');
                return;
            }
            if (!command.role) {
                debug('no blocking role specified');
                return;
            }
            if (action.blockedBy.indexOf(command.role) < 0) {
                debug('action cannot be blocked by that role');
                return;
            }
            // Original player is in the playerIdx field; blocking player is in the target field.
            addHistory(playerIdx, 'attempted to block with ' + command.role);
            state.state = createState(stateNames.BLOCK_RESPONSE, state.state.playerIdx, state.state.action, playerIdx, null, command.role);

        } else if (command.command == 'allow') {
            if (state.state.name == stateNames.BLOCK_RESPONSE) {
                if (state.state.target == playerIdx) {
                    debug('cannot allow your own block');
                    return;
                }
                addHistory(state.state.target, 'blocked with ' + state.state.role);
                nextTurn();
            } else if (state.state.name == stateNames.ACTION_RESPONSE) {
                if (state.state.playerIdx == playerIdx) {
                    debug('cannot allow your own move');
                    return;
                }
                if (playAction(state.state.playerIdx, state.state)) {
                    nextTurn();
                }
            } else {
                debug('incorrect state');
                return;
            }

        } else if (command.command == 'exchange') {
            if (state.state.name != stateNames.EXCHANGE) {
                debug('incorrect state');
                return;
            }
            if (state.state.playerIdx != playerIdx) {
                debug('not your turn');
                return;
            }
            if (!command.roles) {
                debug('must specify roles to exchange');
                return;
            }
            var influenceCount = countInfluence(player);
            if (command.roles.length != influenceCount) {
                debug('wrong number of roles');
                return;
            }
            for (i = 0; i < player.influence.length; i++) {
                if (!player.influence[i].revealed) {
                    player.influence[i].role = command.roles.pop()
                }
            }
            addHistory(playerIdx, ' exchanged roles');
            nextTurn();

        } else {
            debug('unknown command');
            return;
        }

        emitState();
    }

    function challenge(playerIdx, challengedPlayerIdx, challegedRole) {
        var player = state.players[playerIdx];
        var challengedPlayer = state.players[challengedPlayerIdx];
        if (!challengedPlayer) {
            debug('cannot identify challenged player');
            return;
        }
        var influenceIdx = indexOfInfluence(challengedPlayer, challegedRole);
        if (influenceIdx != null) {
            // Player has role - challenge lost.
            addHistory(playerIdx, 'incorrectly challenged', challengedPlayerIdx);
            var influenceCount = countInfluence(player);
            if (influenceCount <= 1 ||
                (influenceCount <= 2 && state.state.name == stateNames.ACTION_RESPONSE && state.state.action == 'assassinate')) {
                // The player is dead (challenging an assassination and failing loses you two influnece)
                // todo: this is only true if the challenger was the target of the assassination
                killPlayer(playerIdx);
            } else {
                if (state.state.name == stateNames.ACTION_RESPONSE && state.state.action != 'exchange') {
                    // The action was unsuccessfully challenged, so play it.
                    // If the action was an exchange, the exchange must place after the reveal.
                    playAction(state.state.playerIdx, state.state);
                }
                state.state = createState(stateNames.REVEAL_INFLUENCE, state.state.playerIdx, state.state.action, playerIdx, 'failed challenge');
            }
            // Deal the challenged player a replacement card.
            challengedPlayer.influence[influenceIdx].role = swapRole(challengedPlayer.influence[influenceIdx].role);
        } else {
            // Player does not have role - challenge won.
            addHistory(playerIdx, 'successfully challenged', challengedPlayerIdx);
            influenceCount = countInfluence(challengedPlayer);
            if (influenceCount <= 1 ||
                (influenceCount <= 2 && state.state.name == stateNames.BLOCK_RESPONSE && state.state.action == 'assassinate')) {
                // The player is dead (challenging a contessa block of an assassination and succeeding takes out two influence)
                killPlayer(challengedPlayerIdx);
            } else {
                if (state.state.name == stateNames.BLOCK_RESPONSE) {
                    // The block was successfully challenged, so play the original action.
                    playAction(state.state.playerIdx, state.state);
                }
                state.state = createState(stateNames.REVEAL_INFLUENCE, state.state.playerIdx, state.state.action, challengedPlayerIdx, 'successfully challenged');
            }
        }
    }

    function playAction(playerIdx, actionState) {
        debug('playing action');
        var player = state.players[playerIdx];
        var action = actions[actionState.action];
        player.cash += action.gain || 0;
        if (actionState.action == 'assassinate') {
            addHistory(playerIdx, 'assassinated', actionState.target);
            state.state = createState(stateNames.REVEAL_INFLUENCE, playerIdx, actionState.action, actionState.target, 'assassinated');
            return false; // Not yet end of turn
        } else if (actionState.action == 'coup') {
            addHistory(playerIdx, 'staged a coup on', actionState.target);
            state.state = createState(stateNames.REVEAL_INFLUENCE, playerIdx, actionState.action, actionState.target, 'coup');
            return false; // Not yet end of turn
        } else if (actionState.action == 'steal') {
            var target = state.players[actionState.target];
            addHistory(playerIdx, 'stole from', actionState.target);
            if (target.cash >= 2) {
                target.cash -= 2;
                player.cash += 2;
            } else {
                player.cash += target.cash;
                target.cash = 0;
            }
        } else if (actionState.action == 'exchange') {
            sockets[playerIdx].emit('exchange-options', [
                deck.pop(), deck.pop()
            ]);
            state.state = createState(stateNames.EXCHANGE, playerIdx, actionState.action);
            return false; // Not yet end of turn
        } else {
            addHistory(playerIdx, 'drew ' + actionState.action);
        }
        return true; // End of turn
    }

    function swapRole(role) {
        deck.push(role);
        deck = shuffle(deck);
        return deck.pop();
    }

    function nextTurn() {
        debug('next turn');
        state.state = createState(stateNames.START_OF_TURN, nextPlayerIdx());
    }

    function indexOfInfluence(player, role) {
        for (var i = 0; i < player.influence.length; i++) {
            if (player.influence[i].role == role && !player.influence[i].revealed) {
                return i;
            }
        }
        return null;
    }

    function nextPlayerIdx() {
        var playerIdx = state.state.playerIdx;
        for (var i = 1; i < numPlayers; i++) {
            var candidateIdx = (playerIdx + i) % numPlayers;
            if (countInfluence(state.players[candidateIdx])) {
                return candidateIdx;
            }
        }
        debug('no more players');
        return null;
    }

    function createState(stateName, playerIdx, action, target, message, role) {
        return {
            name: stateName,
            playerIdx: typeof playerIdx != 'undefined' ? playerIdx : null,
            action: action || null,
            target: typeof target != 'undefined' ? target : null,
            message: message || null,
            role: role || null
        };
    }

    function debug(obj) {
        console.log(obj);
    }

    function shuffle(array) {
        var shuffled = [];
        while (array.length) {
            var i = Math.floor(Math.random() * array.length);
            var e = array.splice(i, 1);
            shuffled.push(e[0]);
        }
        return shuffled;
    }

    function buildDeck() {
        var roles = {};
        for (var actionName in actions) {
            var action = actions[actionName];
            if (action.role) {
                roles[action.role] = true;
            }
            if (action.blockedBy) {
                for (var i = 0; i < action.blockedBy.length; i++) {
                    roles[action.blockedBy[i]] = true;
                }
            }
        }
        var deck = [];
        for (var i = 0; i < 3; i++) {
            deck = deck.concat(Object.keys(roles));
        }
        return deck;
    }

    function addHistory(playerIdx, message, target) {
        state.history.push({
            playerIdx: playerIdx,
            message: message,
            target: target
        });
    }

    return {
        playerJoined: playerJoined,
        playerLeft: playerLeft,
        isActive: isActive,
        command: command
    };
};