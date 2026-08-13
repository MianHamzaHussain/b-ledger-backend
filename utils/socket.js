import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { getAllowedOrigins } from './cors.js';

let io;

/** Room every full-access user joins; receives all events. */
export const GLOBAL_ROOM = 'global';

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
