// GameRoom extends ChatRoom

var _ = require("lodash");
var util = require("util");
var ChatRoom = require("./chatroom");
var SFGame = require("./sfgame");


function GameRoom(params) {
	ChatRoom.call(this, params);
	
	this.maxUsers = (params && typeof params.maxUsers === 'number') ? params.maxUsers : GameRoom.MAX_PLAYERS;
	
	// custom rules
	this.custom = params && params.custom;
	
	// room access
	this.password = undefined; 	// not used yet
	this.blockedUsers = []; 	// list of ids of users who've been booted from the room
	this.bootVotes = {};		// map: boot voter connection : boot target id
	
	// voting to start a game (everyone in room must have clicked Start; need at least 3 players to start)
	this.startVotes = {};
	
	
	this.game = undefined;  // when game is in progress, this is a SFGame object
	
	
	// set up flood protection
	this.setupFloodWatch(GameRoom.FLOOD_INTERVAL, GameRoom.FLOOD_MAXIMUM, GameRoom.FLOOD_SQUELCH_TIME);
}

util.inherits(GameRoom, ChatRoom);


// CONSTANTS
GameRoom.MAX_PLAYERS = 6;
GameRoom.MIN_PLAYERS = 3;

GameRoom.PING_TIMEOUT = 20000;  // 20 seconds without pings until disconnection!


// flood protection - since ingame chat has separate chat windows per user, this is more to prevent bandwidth-eating
GameRoom.FLOOD_MAXIMUM  = 30;		// if user sends more than 30 chats
GameRoom.FLOOD_INTERVAL = 25000; 	// in 25 seconds
GameRoom.FLOOD_SQUELCH_TIME = 60000;// then squelch them for 60 seconds


// METHODS

// call with avatars=true to include avatar info in the occupants list
GameRoom.prototype.getInfo = function(avatars) {
	var info = GameRoom.super_.prototype.getInfo.call(this);
	
	// add game status to info
	if (this.game) info.status = 'fighting';
	else if (this.occupants.length >= this.maxUsers) info.status = 'full';
	else info.status = 'open';
	
	// add custom game rules to info
	if (this.custom) info.custom = this.custom;
	
	if (avatars) {
		// add startVotes and bootVotes to info so latecomers to game can see who has already pressed start and who's getting booted
		var bootVotes = this.countBootVotes();
		info.occupants = _.map(this.occupants, function(conn){
			return {
				started:	this.startVotes[conn],
				bootVotes:	bootVotes[conn.user.id] || 0,
				id:			conn.user.id,
				nickname:	conn.user.nickname,
				avatar:		conn.user.avatar
			}
		}, this);
	} // else use the default [id,nickname] from parent ChatRoom
	
	info.type = "GameRoom";
	
	return info;
}

// join override:
//   check for full or fighting; update full status
//	 callback: done(err, info about this room)
GameRoom.prototype.join = function(conn, done) {
	if (this.game) {
		if (done) done({where:'gameroom', room:this.id, roomName:this.name, error:"fighting", message: "They're already fighting in there"});
	}
	else if (this.occupants.length >= this.maxUsers) {
		if (done) done({where:'gameroom', room:this.id, roomName:this.name, error:"full", message: "Game is full"});
	}
	else if (this.blockedUsers.indexOf(conn.user.id) != -1) {
		if (done) done({where:'gameroom', room:this.id, roomName:this.name, error:"booted", message: "You've been booted from this room"});
	}
	// future: check for password?

	else {
				
		// before entering room and broadcasting my avatar, assign a uniform color: find first color not already taken
		var myAvatar = _.cloneDeep(conn.user.avatar); // have to replace entire avatar object, because of the way it's serialized in the User model
		delete myAvatar['uniformcolor'];
		
		for (var i=0; i<this.maxUsers; i++) {
			if (! _.find(this.occupants, function(occupant){return (occupant != conn && occupant.user.avatar.uniformcolor==i)})) {
				myAvatar.uniformcolor = i;
				conn.user.avatar = myAvatar;
				break;
			}
		}
				
		GameRoom.super_.prototype.join.call(this, conn, function(err, roomInfo) {
			if (!err) {
				console.log("gameroom joined by " + conn.user.nickname);
	
				
				// if room's full, broadcast update so client can lock it			
				if (this.occupants.length == this.maxUsers) {
					this.emit('update', {update:'status', roomInfo:roomInfo});
				}
				// for the join message, include avatars of occupants with getInfo(true)
				roomInfo = this.getInfo(true);
				if (done) done(null, roomInfo);
			}
			
			else {
				if (done) done(err);
			}
		}.bind(this));  // why do i need bind here to get the right This, when i never needed it before??
	}
}


// leave override:
//   update full status
//	 callback: done(err, info about this room)
GameRoom.prototype.leave = function(conn, done) {
	GameRoom.super_.prototype.leave.call(this, conn, function(err, roomInfo) {
		if (!err) {
			// clear start vote
			delete this.startVotes[conn];
			
			// clear boot vote
			delete this.bootVotes[conn];
			// delete any boot votes against me
			this.bootVotes = _.omit(this.bootVotes, function(id) {return id==conn.user.id});
			
			// let the game know, if any
			if (this.game) this.game.leave(conn);
			// ...if not in game, update boot vote status in case votes have changed
			else this.bootUpdate();
			
			// if nobody's left, delete the game
			if (this.occupants.length==0) this.game = undefined;
			
			// update status
			if (!this.game && this.occupants.length < this.maxUsers) {
				this.emit('update', {update:'status', roomInfo:this.getInfo()});
			}
			if (done) done(null, roomInfo);
		}
		
		else {
			if (done) done(err);
		}
	}.bind(this)); // why do i need bind here too to get the right This, when i never needed it before??


}


// broadcastJoin override: include avatar in the join message 
GameRoom.prototype.broadcastJoin = function(conn) {
	this.broadcast("join", {room:this.id, id:conn.user.id, nickname:conn.user.nickname, avatar:conn.user.avatar}, conn);
}


// Client sends ping every few seconds - if pings don't arrive, assume connection is stalled and kick client out of room.
// Take this opportunity to check for stalled connections.
GameRoom.prototype.ping = function(conn, data) {
	conn.pingTime = Date.now();
	//console.log("ping " + conn.user.nickname);
	
	// check everyone else's ping time
	_.each(this.occupants, function(occupant) {
		if (!occupant) {
			console.log("Hey, it's that thing where a stalled user left an undefined occupant in the gameroom.");
		}
		else if (!occupant.pingTime) {
			// they have never pinged! They have one chance...
			occupant.pingTime = Date.now();
		}
		else if ((occupant.pingTime+GameRoom.PING_TIMEOUT) < Date.now()) {
			// kick client out of room and try to disconnect socket
			this.leave(occupant);
			occupant.end();
			console.log("Disconnected stalled user "+conn.user.nickname+" after "+((Date.now()-occupant.pingTime)/1000)+" seconds");
		}
	}, this);
}


// handle game actions from client (events of type 'act')
GameRoom.prototype.act = function(conn, data) {
	//console.log("GameRoom: got action", data, "from", conn.user.nickname,'in gameroom', this.name, this.id);
	
	// let everyone know the user chose an action, except timeout and boot / don't boot
	if (data.action != 'timeout' && data.action != 'boot' && data.action != 'dont') this.broadcast("gameEvent", {event:'acted', id:conn.user.id});

	// if there's a game running, let it handle the action
	if (this.game) this.game.act(conn, data);
	
	else {
		if (data.action=='start') {
			this.bootVotes = {};
			this.startVotes[conn] = true;
			var votes = _.size(this.startVotes);
			if (votes >= GameRoom.MIN_PLAYERS && votes==this.occupants.length) {
				// reset vote counter
				this.startVotes = {};
				// start the game!
				this.startGame();
			}
		}
		else if (data.action=='boot' || data.action=='dont') {
			// boot has a target, dont has no target
			if (data.target) this.bootVotes[conn] = data.target;
			else delete this.bootVotes[conn];
			this.bootUpdate();
		}
	}
}


// check if anyone is booted; update boot votes for client
GameRoom.prototype.bootUpdate = function() {
	// count the votes
	var counter = this.countBootVotes();
	
	// did someone get booted? (everyone else voted to boot them, minimum 2)
	var threshold = this.occupants.length - 1; 
	if (threshold >= 2) {
		var booted = _.findKey(counter, function(votes) { 
			return (votes >= threshold);
		});
		if (booted) {
			this.bootByID(booted);
			return; // don't send boot counter update
		}
	}
	
	// send boot counter update
	this.broadcast("gameEvent", {event:'bootVotes', votes:counter});
}

GameRoom.prototype.countBootVotes = function() {
	var counter = {};
	_.each(this.bootVotes, function(target) {
		if (counter[target]) counter[target]++;
		else counter[target] = 1;
	}, this);
	return counter;
}

// boot someone!
GameRoom.prototype.bootByID = function(bootedID) {
	// clear the votes
	this.bootVotes = {};
	
	// kick out the target
	var bootedConn = _.find(this.occupants, function(conn) {
		return conn.user.id == bootedID;
	}, this);
	if (bootedConn) {
		this.blockedUsers.push(bootedConn.user.id);
		bootedConn.bootMe();
	}
	else {
		// couldn't find that connection? probably can't happen, but just in case:
		console.log("GameRoom", this.id, this.name, "could't find booted user with id", bootedID);
	}
	
	// tell the clients
	this.broadcast("gameEvent", {event:'booted', target:bootedID});

}



// start a new game
GameRoom.prototype.startGame = function() {
	console.log("GameRoom", this.id, this.name, "starting game with occupants " + this.getOccupantNicknames().join(", ") + " and custom rules ", this.custom);
	this.game = new SFGame(this, this.custom);
	this.game.on('gameOver', this.gameOver.bind(this));

	this.emit('update', {update:'status', roomInfo:this.getInfo()});
}


// game tells me it's over!
GameRoom.prototype.gameOver = function() {
	if (this.game) {
		this.game.removeAllListeners();
		this.game = undefined;
	}
	console.log("GameRoom", this.id, this.name, "just ended game");
	this.emit('update', {update:'status', roomInfo:this.getInfo()});
}




module.exports = GameRoom;