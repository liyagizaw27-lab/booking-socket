let ioRef;
const jwt = require('jsonwebtoken');
const geolib = require('geolib');
const mongoose = require('mongoose');
const { getDriverById } = require('../integrations/userServiceClient');
require('dotenv').config();

// Models
const { Booking } = require('../models/bookingModels');
const { Driver, Passenger } = require('../models/userModels');

// In-memory storage for booking notes (last N notes per booking)
const bookingNotes = new Map();
const MAX_NOTES_PER_BOOKING = 50;

// Helper: join user to booking tunnel rooms for their active bookings
async function joinBookingRooms(socket, user) {
  if (!user || !user.id) return;

  try {
    const userType = String(user.type).toLowerCase();
    let query = {};

    if (userType === 'driver') {
      query = { driverId: String(user.id), status: { $in: ['accepted', 'ongoing'] } };
    } else if (userType === 'passenger') {
      query = { passengerId: String(user.id), status: { $in: ['requested', 'accepted', 'ongoing'] } };
    }

    const activeBookings = await Booking.find(query).select('_id').lean();
    activeBookings.forEach(booking => {
      const room = `booking:${String(booking._id)}`;
      socket.join(room);
      console.log(`[joinBookingRooms] ${userType} ${user.id} joined booking room ${room}`);
    });
  } catch (err) {
    console.error('[joinBookingRooms] Error:', err);
  }
}

// Helper: get stored notes for a booking
function getStoredNotes(bookingId) {
  return bookingNotes.get(String(bookingId)) || [];
}

// Helper: find all active drivers
async function findActiveDrivers() {
  return Driver.find({ available: true }).lean();
}

// Resolve a canonical driver document from token claims
async function resolveDriverFromToken(decoded) {
  if (!decoded) return null;
  const id = decoded.id ? String(decoded.id) : null;
  const phone = decoded.phone || decoded.phoneNumber || decoded.mobile;
  const email = decoded.email;
  const externalId = decoded.externalId || decoded.userExternalId;
  const candidates = [];
  if (id) candidates.push({ _id: id });
  if (externalId) candidates.push({ externalId });
  if (phone) candidates.push({ phone });
  if (email) candidates.push({ email });
  for (const query of candidates) {
    const doc = await Driver.findOne(query).lean();
    if (doc) return doc;
  }
  return null;
}

// Resolve a canonical passenger id from token claims
async function resolvePassengerIdFromToken(decoded) {
  if (!decoded) return null;
  const id = decoded.id ? String(decoded.id) : null;
  const phone = decoded.phone || decoded.phoneNumber || decoded.mobile;
  const email = decoded.email;
  const externalId = decoded.externalId || decoded.userExternalId;

  if (id) {
    try {
      const p = await Passenger.findById(id).select({ _id: 1 }).lean();
      if (p) return String(p._id);
    } catch (_) {}
  }

  const altQueries = [];
  if (externalId) altQueries.push({ externalId });
  if (phone) altQueries.push({ phone });
  if (email) altQueries.push({ email });
  for (const q of altQueries) {
    const p = await Passenger.findOne(q).select({ _id: 1 }).lean();
    if (p) return String(p._id);
  }

  return id || null;
}

function attachSocketHandlers(io) {
  if (ioRef) {
    console.warn('[attachSocketHandlers] Socket server already attached. Overwriting ioRef.');
  }
  ioRef = io;

  io.on('connection', async (socket) => {
    console.log(`[connection] New socket connected: ${socket.id}`);

    let user = null;

    // --- Authenticate user on connect ---
    try {
      const rawToken = socket.handshake.auth?.token
        || socket.handshake.query?.token
        || socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '');
      if (rawToken) {
        const decoded = jwt.verify(rawToken, process.env.JWT_SECRET || 'secret');
        console.log('[connection] Decoded JWT:', decoded);

        const normalizedType = decoded && decoded.type ? String(decoded.type).toLowerCase() : '';

        if (normalizedType === 'driver') {
          const driverDoc = await resolveDriverFromToken(decoded);
          const driverId = driverDoc ? String(driverDoc._id) : (decoded.id ? String(decoded.id) : undefined);
          user = { type: 'driver', id: driverId, vehicleType: driverDoc?.vehicleType, name: driverDoc?.name || decoded.name, phone: driverDoc?.phone || (decoded.phone || decoded.phoneNumber || decoded.mobile) };
          // Persist auth token on socket for later service calls
          socket.authToken = rawToken;

          // If vehicleType or vehicle details are missing, hydrate from User Service
          if (driverId && (!user.vehicleType || !user.carPlate || !user.carModel || !user.carColor)) {
            try {
              const authHeader = rawToken ? { Authorization: rawToken.startsWith('Bearer ') ? rawToken : `Bearer ${rawToken}` } : undefined;
              const driverProfile = await getDriverById(driverId, { headers: authHeader || {} });
              if (driverProfile) {
                user.vehicleType = user.vehicleType || driverProfile.vehicleType;
                user.carPlate = driverProfile.carPlate;
                user.carModel = driverProfile.carModel;
                user.carColor = driverProfile.carColor;
              }
            } catch (_) {}
          }
          socket.user = user;
          console.log('[connection] Authenticated driver:', user);

          if (driverId) {
            const room = `driver:${driverId}`;
            socket.join(room);
            socket.join('drivers');
            console.log(`[connection] Driver ${driverId} joined rooms: ${room}, 'drivers'`);

            await joinBookingRooms(socket, user);
          }
        } else if (normalizedType === 'passenger') {
          const passengerId = await resolvePassengerIdFromToken(decoded);
          user = { type: 'passenger', id: passengerId || (decoded.id ? String(decoded.id) : undefined), name: decoded.name, phone: decoded.phone || decoded.phoneNumber || decoded.mobile };
          socket.user = user;
          console.log('[connection] Authenticated passenger:', user);

          if (user.id) {
            socket.join(`passenger:${user.id}`);
            await joinBookingRooms(socket, user);
          }
        } else {
          throw new Error('Unsupported user type');
        }
      }
    } catch (err) {
      console.error('[connection] Socket auth error:', err);
      socket.disconnect(true);
      return;
    }

    // --- booking_request ---
    socket.on('booking_request', async (payload) => {
      console.log('[booking_request] Payload received:', payload);
      try {
        const bookingData = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
        const authUser = socket.user;
        console.log('[booking_request] Authenticated user:', authUser);

        if (!authUser || String(authUser.type).toLowerCase() !== 'passenger') {
          return socket.emit('booking_error', { message: 'Unauthorized: passenger token required' });
        }

        const passengerId = socket.user.id;
        bookingData.passengerId = passengerId;
        bookingData.vehicleType = bookingData.vehicleType || 'mini';
        bookingData.status = bookingData.status || 'requested';

        const booking = await Booking.create(bookingData);
        console.log('[booking_request] Booking created:', booking._id);

        const bookingRoom = `booking:${booking._id}`;
        socket.join(bookingRoom);
        console.log(`[booking_request] Passenger ${passengerId} joined booking room ${bookingRoom}`);

        const drivers = await findActiveDrivers();
        const radiusKm = parseInt(process.env.RADIUS_KM || '5', 10);
        const nearbyDrivers = drivers.filter(d => d.lastKnownLocation && (
          geolib.getDistance(
            { latitude: d.lastKnownLocation.latitude, longitude: d.lastKnownLocation.longitude },
            { latitude: booking.pickup.latitude, longitude: booking.pickup.longitude }
          ) / 1000
        ) <= radiusKm);

        console.log('[booking_request] Nearby drivers:', nearbyDrivers.map(d => d._id));

        const patch = {
          bookingId: String(booking._id),
          patch: {
            status: 'requested',
            passengerId,
            vehicleType: booking.vehicleType,
            pickup: booking.pickup,
            dropoff: booking.dropoff,
            passenger: { id: passengerId, name: socket.user.name, phone: socket.user.phone }
          }
        };

        nearbyDrivers.forEach(d => {
          const driverRoomId = String(d._id);
          io.to(`driver:${driverRoomId}`).emit('booking:new', patch);
          console.log(`[booking_request] Emitted 'booking:new' to driver:${driverRoomId}`);
        });
        io.to('drivers').emit('booking:new', patch);
        console.log('[booking_request] Emitted "booking:new" to all drivers fallback');

      } catch (err) {
        console.error('[booking_request] Error:', err);
      }
    });

    // --- booking_accept ---
    socket.on('booking_accept', async (payload) => {
      console.log('[booking_accept] Payload received:', payload);
      try {
        const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
        const bookingIdRaw = data.bookingId;
        const authUser = socket.user;
        console.log('[booking_accept] Authenticated user:', authUser);

        if (!authUser || String(authUser.type).toLowerCase() !== 'driver' || !authUser.id) {
          return socket.emit('booking_error', { message: 'Unauthorized: driver token required', bookingId: bookingIdRaw });
        }

        if (!bookingIdRaw) {
          return socket.emit('booking_error', { message: 'bookingId is required', bookingId: bookingIdRaw });
        }

        let bookingObjectId;
        try {
          bookingObjectId = new mongoose.Types.ObjectId(String(bookingIdRaw));
        } catch (_) {
          return socket.emit('booking_error', { message: 'Invalid bookingId', bookingId: bookingIdRaw });
        }

        const now = new Date();
        const accepted = await Booking.findOneAndUpdate(
          { _id: bookingObjectId, status: 'requested' },
          { $set: { status: 'accepted', driverId: String(authUser.id), acceptedAt: now } },
          { new: true }
        ).lean();

        if (!accepted) {
          return socket.emit('booking_error', { message: 'Booking already accepted by another driver or not found', bookingId: bookingIdRaw });
        }

        const bookingId = String(accepted._id);
        const bookingRoom = `booking:${bookingId}`;

        socket.join(bookingRoom);
        console.log(`[booking_accept] Driver ${authUser.id} joined booking room ${bookingRoom}`);

        const patch = {
          bookingId,
          patch: {
            status: 'accepted',
            driverId: String(authUser.id),
            acceptedAt: now.toISOString(),
            driver: {
              id: String(authUser.id),
              name: authUser.name,
              phone: authUser.phone,
              vehicleType: authUser.vehicleType,
              vehicle: {
                type: authUser.vehicleType,
                plate: authUser.carPlate,
                model: authUser.carModel,
                color: authUser.carColor,
              }
            }
          }
        };

        io.to(bookingRoom).emit('booking:update', patch);
        io.to(`driver:${String(authUser.id)}`).emit('booking:accepted', patch);
        console.log(`[booking_accept] Emitted 'booking:update' and 'booking:accepted' for booking ${bookingId}`);

      } catch (err) {
        console.error('[booking_accept] Error:', err);
      }
    });

    // --- booking_cancel ---
    socket.on('booking_cancel', async (payload) => {
      console.log('[booking_cancel] Payload received:', payload);
      try {
        const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
        const bookingIdRaw = data.bookingId;
        const reason = data.reason;
        const authUser = socket.user;
        console.log('[booking_cancel] Authenticated user:', authUser);

        if (!authUser || !authUser.type) {
          return socket.emit('booking_error', { message: 'Unauthorized: user token required', bookingId: bookingIdRaw });
        }

        if (!bookingIdRaw) {
          return socket.emit('booking_error', { message: 'bookingId is required', bookingId: bookingIdRaw });
        }

        let bookingObjectId;
        try {
          bookingObjectId = new mongoose.Types.ObjectId(String(bookingIdRaw));
        } catch (_) {
          return socket.emit('booking_error', { message: 'Invalid bookingId', bookingId: bookingIdRaw });
        }

        const canceledBy = String(authUser.type).toLowerCase() === 'driver' ? 'driver' : 'passenger';

        const updated = await Booking.findOneAndUpdate(
          { _id: bookingObjectId },
          { $set: { status: 'canceled', canceledBy, canceledReason: reason } },
          { new: true }
        ).lean();

        if (!updated) {
          return socket.emit('booking_error', { message: 'Booking not found', bookingId: bookingIdRaw });
        }

        const bookingId = String(updated._id);
        const bookingRoom = `booking:${bookingId}`;

        const patch = {
          bookingId,
          patch: { status: 'canceled', canceledBy, canceledReason: reason }
        };

        io.to(bookingRoom).emit('booking:update', patch);
        const actorRoom = canceledBy === 'driver' ? `driver:${String(authUser.id)}` : `passenger:${String(authUser.id)}`;
        io.to(actorRoom).emit('booking:cancelled', patch);
        console.log(`[booking_cancel] Emitted 'booking:update' and 'booking:cancelled' for booking ${bookingId}`);

      } catch (err) {
        console.error('[booking_cancel] Error:', err);
      }
    });

    // --- booking_note ---
    socket.on('booking_note', async (payload) => {
      console.log('[booking_note] Payload received:', payload);
      try {
        const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
        const bookingIdRaw = data.bookingId;
        const message = data.message;
        const authUser = socket.user;
        console.log('[booking_note] Authenticated user:', authUser);

        if (!authUser || !authUser.type || !bookingIdRaw || !message) {
          return socket.emit('booking_error', { message: 'Invalid note or unauthorized', bookingId: bookingIdRaw });
        }

        const note = {
          bookingId: String(bookingIdRaw),
          sender: String(authUser.type).toLowerCase(),
          message: message.trim(),
          timestamp: new Date().toISOString()
        };

        if (!bookingNotes.has(String(bookingIdRaw))) bookingNotes.set(String(bookingIdRaw), []);
        const notes = bookingNotes.get(String(bookingIdRaw));
        notes.push(note);
        if (notes.length > MAX_NOTES_PER_BOOKING) notes.splice(0, notes.length - MAX_NOTES_PER_BOOKING);

        io.to(`booking:${String(bookingIdRaw)}`).emit('booking:note', note);
        console.log(`[booking_note] Emitted note to booking:${bookingIdRaw}`);

      } catch (err) {
        console.error('[booking_note] Error:', err);
      }
    });

    // --- booking_notes_fetch ---
    socket.on('booking_notes_fetch', async (payload) => {
      console.log('[booking_notes_fetch] Payload received:', payload);
      try {
        const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
        const bookingIdRaw = data.bookingId;
        const authUser = socket.user;
        console.log('[booking_notes_fetch] Authenticated user:', authUser);

        if (!authUser || !bookingIdRaw) {
          return socket.emit('booking_error', { message: 'Unauthorized or missing bookingId', bookingId: bookingIdRaw });
        }

        const notes = getStoredNotes(bookingIdRaw);
        socket.emit('booking:notes_history', { bookingId: String(bookingIdRaw), notes });
        console.log(`[booking_notes_fetch] Sent notes history for booking:${bookingIdRaw}`);

      } catch (err) {
        console.error('[booking_notes_fetch] Error:', err);
      }
    });

    // --- disconnect ---
    socket.on('disconnect', () => {
      console.log(`[disconnect] Socket disconnected: ${socket.id}`);
      if (socket.user && socket.user.id) {
        console.log(`[disconnect] ${socket.user.type} ${socket.user.id} disconnected and left all rooms`);
      }
    });
  });
}

module.exports = { attachSocketHandlers };
