/*
	sockjs controllers
	
	For now, controllers are simple, so they can all sit in one file
	Split 'em out if they get too big
*/

var User = require("../models/user");
var Homeroom = require('../gameObjects/homeroom');

var _ = require('lodash');

var userConnections = {}; // map users to connections ####todo: make sure there's no way for a dropped connection to lead to a user staying in this list and not being able to reconnect

exports.init = function(app, sockjs) {
	// since i'm merging socket native events with chat events, don't accept any chat events with names that match the native ones
	var EVENT_BLACKLIST = ['data', 'close']; 

	
	// new socket connection!
	sockjs.on("connection", function(conn) {
		/* NATIVE SOCKET EVENTS */
	
		// add json writer with event name (string) and data payload (json)
		conn.writeEvent = function(type, data) {
			if (conn.writable) conn.write(JSON.stringify({type: type, data: data}));
		}
		
		// Decode incoming messages of form {type:'event name', data: {event data or null}} and ignore others.
		// Dispatch good messages as events, except ones that could be confused with sockjs events.
		conn.on("data", function(data) {
			//socketListener(conn, message);
			var message;
			
			try { 
				//console.log("incoming: ", data);
				message = JSON.parse(data); 
				//console.log("decoded: ", message);
			}
			catch (err) {
				return;
			};
			if ((typeof message)==='object' && (typeof message.type)==='string' && (message.data===undefined || typeof message.data==='object')) {
				if (EVENT_BLACKLIST.indexOf(message.type)==-1) {
					conn.emit(message.type, message.data);
				}
			}
		});
		
		conn.on("close", closeListener);
		
		conn.on("login", loginListener);
		
		conn.bootMe = bootToHomeroomListener.bind(conn); // there's probably a less horrible way to do this!

	});
	
	
	function registerSissyfightEvents(conn) {
		/* SISSYFIGHT EVENTS ---------------------- */
												
		conn.on("say", sendChatListener);
		conn.on("saveAvatar", saveAvatarListener);
		conn.on("dressingRoom", returnToDressingRoomListener);
		conn.on("homeroom", returnToHomeroomListener);
		conn.on("joingame", joinGameListener);
		conn.on("act", gameActionListener);
		conn.on("ping", gamePingListener);
		conn.on("newgame", newGameListener);
	}
	

	
	
	function closeListener(data) {
		var conn = this;
		if (conn.room) conn.room.leave(conn, null);
		if (conn.user) delete userConnections[conn.user.id];
		if (conn.user) console.log("Socket: user " + conn.user.nickname + " disconnected - " + JSON.stringify(data));
	}
	

	
	function loginListener(data) {
		var conn = this; 
		
		// try to connect with the session
		if (data.session && (typeof data.session)==='string' && data.token && (typeof data.token)==='string') {
			app.get('sessionStore').get(data.session, function(err, session) {
				if (err) {
					console.log("Socket login: couldn't access session store for session id " + data.session + ": " + err);
					conn.writeEvent("loginError", {where:"login", error:"nostore", message: "Couldn't access session store: " + err.toString()});
				}
				else if (!session) {
					console.log("Socket login: no such session " + data.session);
					conn.writeEvent("loginError", {where:"login", error:"nosession", message: "No such session"});
				}
				else if (!session.user) {
					console.log("Socket login: session's not logged in " + data.session);	
					conn.writeEvent("loginError", {where:"login", error:"notlogged", message: "Session's not logged in"});
				}
				else if (session.token !== data.token) {
					console.log("Socket login: bad token " + data.token + " for session " + data.session);
					conn.writeEvent("loginError", {where:"login", error:"token", message: "Bad token"});
				}
				else if (userConnections[session.user.id]) {
					console.log("Socket login: user "+session.user.nickname+" already has a connected socket");
					conn.writeEvent("loginError", {where:"login", error:"multi", message: "Already connected"});
				}
				else if (!session.school || !app.get('schools')[session.school]) {
					console.log("Socket login: user "+session.user.nickname+" has unknown school " + session.school);
					conn.writeEvent("loginError", {where:"login", error:"noschool", message: "Unknown school"});
				}
				else {
					// everything is good: socket corresponds to a logged-in session - connect the user
					conn.removeListener("login", loginListener);
					
					// grab fresh user object (deserialized user from session may be out of date, and it doesn't have ORM methods)
					User.find(session.user.id).complete( function(err, user) {
						if (err) {
							console.log("Socket login: couldn't find user object due to database problem: " + err);
							conn.writeEvent("loginError", {where:"login", error:"dbusererr", message: "Database trouble"});
						}
						else if (!user) {
							console.log("Socket login: couldn't find user for id "+session.user.id+" in database")
							conn.writeEvent("loginError", {where:"login", error:"dbnouser", message: "Couldn't find user in db"});
						}
						else {
							console.log("Socket login: retrieved db record for user  " + user.nickname);
						
							conn.user = user;
							conn.school = app.get('schools')[session.school];
							
							userConnections[conn.user.id] = {conn:conn};
							
							console.log("Socket login: found session for socket, user " + session.user.nickname);
							
							if (!conn.user.avatar) conn.user.avatar={};
							
							conn.writeEvent("go", {to:"dressingroom", nickname:conn.user.nickname, avatar:conn.user.avatar, level:conn.user.level});
							
							registerSissyfightEvents(conn);
						}
					});
				}

			});
		}
		else {
			console.log("Socket login: event missing session or token");
			conn.writeEvent("loginError", {error:"tsnotsupp", message:"Missing session or token"});
		}
	}
	
	
	
	function sendChatListener(data) {
		var conn = this;
		if (conn && conn.room && (typeof data.text)==="string") conn.room.say(conn, data.text);
	}	
	
	
	
	// save avatar and go to homeroom
	function saveAvatarListener(data) {
		var conn = this;
		saveAvatar(conn, data, function(err) {
			if (err) {
				conn.writeEvent("error", err);
			}
			else {
				joinHomeroom(conn, data, function(err, homeroom, games) {
					if (err) {
						conn.writeEvent("error", err);
						console.log("saveAvatarListener - error", err);
					}
					else {
						sendGoHomeroom(conn, homeroom, games);
					}
				});
			}
		});
	}
	
	// callback: done(err, avatar)  - useful to send avatar back in case it gets altered by validation code (TODO)
	function saveAvatar(conn, data, done) {
		if (!conn.user) {
			console.log("saveAvatar: socket not logged in");
			done({where:'avatar', error:"notlogged", message:"Socket's not logged in"});
			return;
		}
		var validation = User.validateAvatar(data.avatar, conn.user.level);
		if (validation) {
			console.log("saveAvatar: validation error: " + validation + " in avatar " + JSON.stringify(data.avatar));
			done({where:'avatar', error:'badavatar', message:"Avatar problem"});
			return;
		}
		conn.user.avatar = data.avatar;
		conn.user.save().complete(function(err){
			if (err) {
				console.log("saveAvatar: trouble saving user " + conn.user.nickname + ": " + err);
				if (done) done({where:'avatar', error:"dbaverr", message:"Trouble saving the avatar"});
			}
			else {
				console.log("saveAvatar: avatar set...");
				if (done) done(null,data.avatar);
			}
		});
	}
	

	
	
	// callback: done(err, homeroom, list of games)
	function joinHomeroom(conn, data, done) {
		if (!conn.user) {
			conn.writeEvent("error", {where:"homeroom", error:"notlogged", message:"Socket's not logged in"});
			console.log("joinHomeroomListener: socket not logged in");
			return;
		}
		if (!conn.school) {
			console.log("joinHomeroomListener: user "+conn.user.nickname+" has unknown school");
			conn.writeEvent("error", {where:"homeroom", error:"noschool", message: "Unknown school"});
		}
		if (conn.room) {
			console.log("joinHomeroomListener: user "+conn.user.nickname+" is already in school " + conn.school.id + " room " + conn.room.id);
			conn.writeEvent("error", {where:"homeroom", error:"inaroom", message: "Already in a room"});
		}
		
		conn.school.getHomeroom(function(err, homeroom) {
			if (err) {
				console.log("joinHomeroomListener: user "+conn.user.nickname+" couldn't get school " + conn.school.id + " homeroom: " + err);
				conn.writeEvent("error", {where:"homeroom", error:"nohomeroom", message: err.message});
			}
			else {
				homeroom.join(conn, function(err) {
					if (err) {
						console.log("joinHomeroomListener: user "+conn.user.nickname+" couldn't join school " + conn.school.id + "homeroom " + err);
						//conn.writeEvent("error", err);
						done(err);
					}
					else {
						console.log("joinHomeroomListener: user "+conn.user.nickname+" joined school " + conn.school.id + " homeroom.");
						//conn.writeEvent("go", {to:'homeroom', room:homeroom.id, roomName:homeroom.name, occupants:homeroom.getOccupantNicknames()});
						conn.school.getGameRoomsInfo(function(err, games) {
							// no errors expected
							done(err, homeroom, games);
						});
						
					}
				});
			}
		});
		
	}
	
	
	function returnToDressingRoomListener(data) {
		var conn = this;
		if (!conn.room) {
			// that way lies madness
		}
		else {
			conn.room.leave(conn, function(err) {
				if (err) {
					conn.writeEvent("error", err);
				}
				else {
					conn.writeEvent("go", {to:'dressingroom', avatar:conn.user.avatar, nickname:conn.user.nickname, level:conn.user.level});
				}
			})
		}
	}
	
	
	
	function joinGameListener(data) {
		var conn = this;
		if (conn.room) {
			var homeroom;
			if (conn.room instanceof Homeroom) homeroom = conn.room;
			conn.room.leave(conn, function(err) {
				if (err) {
					conn.writeEvent("error", err);
				}
				else {
					conn.school.getGameRoom(data.room, function(err, gameRoom) {
						if (err) {
							conn.writeEvent("error", err);
						}
						else {
							joinGameRoom(conn, gameRoom, function(err) {
								if (err) {
									conn.writeEvent("error", err);
									// failed to enter gameroom so try to get back into homeroom
									if (homeroom) homeroom.join(conn, function(err) {
										if (err) {
											// things are really messed up if can't get back into the homeroom
											conn.writeEvent("error", {error:"gamehomelimbo", message:"I got lost - please reload :(", reload:true});
										}
									});
									else conn.writeEvent("error", {error:"gamehomelimbo2", message:"I got lost - please reload :(", reload:true});
								}
							});
						}
					});
					
				}
			});
			
		}
	}
	
	function joinGameRoom(conn, gameRoom, done) {
		gameRoom.join(conn, function(err, gameRoomInfo) {
			if (err) {
				if (done) done(err);
			}
			else {
				// sort game occupants so that current player always appears first
				gameRoomInfo.occupants = _.sortBy(gameRoomInfo.occupants, function(occupant) {
					return (occupant.id != conn.user.id);
				});
				conn.writeEvent("go", {to:'gameroom', room:gameRoomInfo, me:conn.user.id});
			}
		});
	}
	
	
	function newGameListener(data) {
		var conn = this;
		// user must be in homeroom to create a game
		if (conn.room && conn.room instanceof Homeroom) {
			conn.school.userCreateGameRoom(data, function(err, gameRoom) {
				if (err) {
					conn.writeEvent("error", err);
				}
				else {
					conn.room.leave(conn, function(err) {
						if (err) {
							conn.writeEvent("error", err);
						}
						else {
							joinGameRoom(conn, gameRoom);
						}
					})
				}
			})
		}
		else {
			conn.writeEvent("error", {error:"newgamenothome", message:"Can't create game room - not in homeroom"});
		}
	}
	
	
	function bootToHomeroomListener(data) {
		var conn = this;
		if (!conn.room) {
			// should not happen!
			console.log("bootToHomeroomListener: connection has no room", conn.user.name);
		}
		else {
			conn.room.leave(conn, function(err) {
				if (err) {
					conn.writeEvent("error", err);
				}
				else {
					joinHomeroom(conn, data, function(err, homeroom, games) {
						if (err) {
							conn.writeEvent("error", err);
						}
						else {
							sendGoHomeroom(conn, homeroom, games, true);
						}
					});				
				}
			})
		}
	}
	
	// set booted = true if user was booted from gameroom
	function returnToHomeroomListener(data, booted) {
		var conn = this;
		if (!conn.room) {
			// should not happen!
			console.log("returnToHomeroomListener: connection has no room", conn.user.name);
		}
		else {
			conn.room.leave(conn, function(err) {
				if (err) {
					conn.writeEvent("error", err);
				}
				else {
					joinHomeroom(conn, data, function(err, homeroom, games) {
						if (err) {
							conn.writeEvent("error", err);
						}
						else {
							sendGoHomeroom(conn, homeroom, games, booted);
						}
					});				
				}
			})
		}
	}
	
	// set booted = true if user was booted from gameroom
	function sendGoHomeroom(conn, homeroom, games, booted) {
		conn.writeEvent("go", {to:'homeroom', games:games, avatar:conn.user.avatar, nickname:conn.user.nickname, occupants:homeroom.getOccupantProperties(), booted: (booted==true)});
	}
	
	
	// forward game actions to game room
	function gameActionListener(data) {
		var conn = this;
		if (conn.room && conn.room.act) conn.room.act(conn,data);
	}
	
	// forward pings to game room
	function gamePingListener(data) {
		var conn = this;
		if (conn.room && conn.room.ping) conn.room.ping(conn,data);
	}

}

// send a string 'announcement' to all connected sockets.
//  sender is {nickname, etc}
//  possibly future extension: add filtering by school, play status, etc?
exports.announceToAll = function (sender, announcement) {
	_.each(userConnections, function(entry, userid) {
		if (entry.conn) entry.conn.writeEvent("announcement", {from:sender.nickname, text:announcement});
	});
};