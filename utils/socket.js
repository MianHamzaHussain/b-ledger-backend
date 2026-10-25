import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { getAllowedOrigins } from './cors.js';
import { userCan } from './permissions.js';
import { createPresence, stampLastActive } from './presence.js';

let io;

/** Room every full-access user joins; receives all events. */
export const GLOBAL_ROOM = 'global';

/** Room of everyone who may see who is online (users:read). Presence goes only here. */
export const PRESENCE_ROOM = 'presence';

/** Who is online. Created here so it lives as long as the socket server. */
export const presence = createPresence({
  onChange: ({ userId, online, lastActiveAt }) => {
    if (lastActiveAt) void stampLastActive(userId, lastActiveAt);
    // io is set by initSocket; a change before that has nobody to tell.
    io?.to(PRESENCE_ROOM).emit('presence', { userId, online, lastActiveAt });
  }
});

/** Room name for one business's events. */
export const businessRoom = businessId => `business:${businessId}`;

export const initSocket = server => {
  io = new Server(server, {
    cors: {
      origin: getAllowedOrigins(),
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
    }
  });

  // Same JWT the REST API uses — an unauthenticated socket never connects.
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;

      if (!token) {
        return next(new Error('Authentication error: No token provided'));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id).populate('role');

      if (!user || user.status === 'inactive') {
        return next(new Error('Authentication error: User not found or inactive'));
      }

      socket.user = user;
      next();
    } catch (error) {
      next(new Error('Authentication error: Invalid or expired token'));
    }
  });

  io.on('connection', socket => {
    // Every signed-in session counts as online, whatever it may read.
    presence.connect(socket.user.id);
    socket.on('disconnect', () => presence.disconnect(socket.user.id));

    // Only people who may see users learn who is online.
    if (userCan(socket.user, 'users', 'read')) socket.join(PRESENCE_ROOM);

    // Business events only reach people who may read notifications — the same rule the screen
    // applies, enforced here so it does not depend on the client.
    if (!userCan(socket.user, 'notifications', 'read')) return;

    // Admins see everything; everyone else only their assigned businesses.
    // This mirrors the `scope: own` rule enforced on the REST side, so a user
    // cannot learn via websocket what they could not fetch over HTTP.
    if (socket.user.role?.fullAccess) {
      socket.join(GLOBAL_ROOM);
    } else {
      (socket.user.assignedBusinesses || []).forEach(id =>
        socket.join(businessRoom(id.toString()))
      );
    }
  });

  return io;
};

export const getIO = () => {
  if (!io) throw new Error('Socket.io has not been initialized!');
  return io;
};

/**
 * Emit to everyone entitled to see a business's events: its assigned users
 * plus all admins.
 */
export const emitToBusiness = (businessId, event, payload) => {
  const server = getIO();
  server.to(businessRoom(businessId.toString())).emit(event, payload);
  server.to(GLOBAL_ROOM).emit(event, payload);
};
