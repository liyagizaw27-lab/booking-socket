const dayjs = require('dayjs');
const geolib = require('geolib');
const { Booking, BookingAssignment, TripHistory, Live, BookingStatus } = require('../models/bookingModels');
const { Pricing } = require('../models/pricing');
const { broadcast } = require('../sockets');
const positionUpdateService = require('../services/positionUpdate');

async function estimateFare({ vehicleType = 'mini', pickup, dropoff }) {
  const distanceKm = geolib.getDistance(
    { latitude: pickup.latitude, longitude: pickup.longitude },
    { latitude: dropoff.latitude, longitude: dropoff.longitude }
  ) / 1000;
  const p = await Pricing.findOne({ vehicleType, isActive: true }).sort({ updatedAt: -1 }) || { baseFare: 2, perKm: 1, perMinute: 0.2, waitingPerMinute: 0.1, surgeMultiplier: 1 };
  const fareBreakdown = {
    base: p.baseFare,
    distanceCost: distanceKm * p.perKm,
    timeCost: 0, // Removed time-based calculation
    waitingCost: 0, // Removed waiting time calculation
    surgeMultiplier: p.surgeMultiplier,
  };
  const fareEstimated = (fareBreakdown.base + fareBreakdown.distanceCost + fareBreakdown.timeCost + fareBreakdown.waitingCost) * fareBreakdown.surgeMultiplier;
  return { distanceKm, fareEstimated, fareBreakdown };
}

exports.create = async (req, res) => {
  try {
    const passengerId = String(req.user?.id);
    if (!passengerId) return res.status(400).json({ message: 'Invalid passenger ID: user not authenticated' });
    const { vehicleType, pickup, dropoff } = req.body;
    if (!pickup || !dropoff) return res.status(400).json({ message: 'Pickup and dropoff locations are required' });
    const est = await estimateFare({ vehicleType, pickup, dropoff });
    const { Passenger } = require('../models/userModels');
    const { Types } = require('mongoose');
    let p = null;
    if (Types.ObjectId.isValid(passengerId)) {
      p = await Passenger.findById(passengerId).select({ _id: 1, name: 1, phone: 1 }).lean();
    }
    // Extract passenger info from JWT token
    const extractFromToken = (user) => {
      if (!user) return {};
      
      
      // The JWT token now contains passenger data directly
      const result = {
        name: user.name || user.fullName || user.displayName,
        phone: user.phone || user.phoneNumber || user.mobile,
        email: user.email
      };
      
      
      return result;
    };
    const tokenMeta = extractFromToken(req.user);
    // Prioritize JWT token data first, then database, then external service
    let passengerName = tokenMeta.name || p?.name || undefined;
    let passengerPhone = tokenMeta.phone || p?.phone || undefined;
    
    // Require real passenger identity
    if (!passengerName || !passengerPhone) {
      try {
        const { getPassengerById } = require('../integrations/userServiceClient');
        const authHeader = req.headers && req.headers.authorization ? { Authorization: req.headers.authorization } : undefined;
        const info = await getPassengerById(passengerId, { headers: authHeader });
        if (info) {
          passengerName = passengerName || info.name;
          passengerPhone = passengerPhone || info.phone;
        }
      } catch (e) { }
    }
    
    // Final validation
    if (!passengerName || !passengerPhone) {
      return res.status(422).json({ message: 'Passenger name and phone are required from auth token or user directory' });
    }

    

    const booking = await Booking.create({ 
      passengerId, 
      passengerName, 
      passengerPhone, 
      vehicleType, pickup, dropoff, 
      distanceKm: est.distanceKm, 
      fareEstimated: est.fareEstimated, 
      fareBreakdown: est.fareBreakdown 
    });
    
    
    const data = {
      id: String(booking._id),
      passengerId,
      passenger: { id: passengerId, name: booking.passengerName, phone: booking.passengerPhone },
      vehicleType,
      pickup,
      dropoff,
      distanceKm: booking.distanceKm,
      fareEstimated: booking.fareEstimated,
      fareFinal: booking.fareFinal,
      fareBreakdown: booking.fareBreakdown,
      status: booking.status,
      createdAt: booking.createdAt,
      updatedAt: booking.updatedAt
    };
    
    // Broadcast to nearest passengers (top 5)
    try {
      const { nearestPassengers } = require('../services/nearbyPassengers');
      const { sendMessageToSocketId } = require('../sockets/utils');
      const nearest = await nearestPassengers({
        latitude: pickup.latitude,
        longitude: pickup.longitude,
        limit: 5
      });
      const targets = (nearest || []).map(x => x.passenger);
      const payload = { ...data };
      const { broadcast } = require('../sockets');
      broadcast('booking:new:broadcast', { ...payload, targetedCount: targets.length, target: 'passengers' });
      targets.forEach(p => sendMessageToSocketId(`passenger:${String(p._id)}`, { event: 'booking:new', data: payload }));
    } catch (e) { console.error('Broadcast to nearest passengers failed:', e); }

    return res.status(201).json(data);
  } catch (e) { return res.status(500).json({ message: `Failed to create booking: ${e.message}` }); }
}

exports.list = async (req, res) => {
  try { 
    const userType = req.user?.type;
    const userId = req.user?.id;
    let query = {};
    
    
    
    // If user is passenger, only show their bookings
    // If user is admin/superadmin, show all bookings
    if (userType === 'passenger') {
      query.passengerId = String(userId);
    }
    // For admin/superadmin, no filter is applied (shows all bookings)
    
    
    const rows = await Booking.find(query).sort({ createdAt: -1 }).lean(); 
    
    
    const { Passenger } = require('../models/userModels');
    const { Types } = require('mongoose');
    const passengerIds = [...new Set(rows.map(r => r.passengerId))];
    
    
    const validObjectIds = passengerIds.filter(id => Types.ObjectId.isValid(id));
    
    
    const passengers = validObjectIds.length
      ? await Passenger.find({ _id: { $in: validObjectIds } }).select({ _id: 1, name: 1, phone: 1 }).lean()
      : [];
    
    
    const pidToPassenger = Object.fromEntries(passengers.map(p => [String(p._id), { id: String(p._id), name: p.name, phone: p.phone }]));
    
    
    // Enhanced passenger lookup for non-ObjectId passengerIds using external directory
    const nonObjectIdPassengerIds = passengerIds.filter(id => !Types.ObjectId.isValid(id));
    let additionalPassengers = {};
    if (nonObjectIdPassengerIds.length > 0) {
      
      
      // Try external service first
      try {
        const { getPassengerById } = require('../services/userDirectory');
        const additionalPassengerPromises = nonObjectIdPassengerIds.map(async (id) => {
          try {
            const authHeader = req.headers && req.headers.authorization ? { Authorization: req.headers.authorization } : undefined;
            const info = await getPassengerById(id, { headers: authHeader });
            return info ? { id, info } : null;
          } catch (e) { return null; }
        });
        const additionalPassengerResults = await Promise.all(additionalPassengerPromises);
        additionalPassengers = Object.fromEntries(
          additionalPassengerResults
            .filter(result => result !== null)
            .map(result => [result.id, { id: result.id, name: result.info.name, phone: result.info.phone }])
        );
      } catch (e) { }
      
      // Do not generate mock passengers
    }
    
    // Get passenger info from JWT token if available
    let jwtPassengerInfo = null;
    if (req.user && req.user.id && req.user.type === 'passenger') {
      
      // The JWT token now contains passenger data directly
      jwtPassengerInfo = {
        id: String(req.user.id),
        name: req.user.name || req.user.fullName || req.user.displayName,
        phone: req.user.phone || req.user.phoneNumber || req.user.mobile,
        email: req.user.email
      };
      
    }

    const authHeader = req.headers && req.headers.authorization ? { Authorization: req.headers.authorization } : undefined;
    const driverIds = [...new Set(rows.map(r => r.driverId).filter(Boolean))];
    let driverInfoMap = {};
    if (driverIds.length) {
      try {
        const { getDriversByIds } = require('../integrations/userServiceClient');
        const infos = await getDriversByIds(driverIds, { headers: authHeader });
        driverInfoMap = Object.fromEntries((infos || []).map(i => [String(i.id), { id: String(i.id), name: i.name, phone: i.phone }]));
      } catch (_) {}
    }

    const normalized = rows.map(b => {
      // Priority order: JWT token data > Stored booking data > Database lookup > External
      let passenger = undefined;
      
      // 1. Try JWT passenger info first (most current)
      if (jwtPassengerInfo && String(jwtPassengerInfo.id) === String(b.passengerId)) {
        passenger = jwtPassengerInfo;
        
      }
      // 2. Try stored passenger data in booking (from creation time)
      else if (b.passengerName || b.passengerPhone) {
        passenger = { id: b.passengerId, name: b.passengerName, phone: b.passengerPhone };
        
      }
      // 3. Try database lookup
      else if (pidToPassenger[b.passengerId]) {
        passenger = pidToPassenger[b.passengerId];
        
      }
      // 4. Try additional passengers (external service)
      else if (additionalPassengers[b.passengerId]) {
        passenger = additionalPassengers[b.passengerId];
        
      }
      // 5. If still missing, leave passenger undefined (no mock)
      
      
      
      const driverBasic = b.driverId ? driverInfoMap[String(b.driverId)] || undefined : undefined;
      return {
      id: String(b._id),
      passengerId: b.passengerId,
        passenger: passenger,
      driverId: b.driverId,
      driver: driverBasic,
      vehicleType: b.vehicleType,
      pickup: b.pickup,
      dropoff: b.dropoff,
      distanceKm: b.distanceKm,
      fareEstimated: b.fareEstimated,
      fareFinal: b.fareFinal,
      fareBreakdown: b.fareBreakdown,
      status: b.status,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt
      };
    });
    
    return res.json(normalized); 
  } catch (e) { 
    console.error('Error in booking list:', e);
    return res.status(500).json({ message: `Failed to retrieve bookings: ${e.message}` }); 
  }
}

exports.get = async (req, res) => {
  try { 
    const userType = req.user?.type;
    let query = { _id: req.params.id };
    
    // If user is passenger, only show their bookings
    // If user is admin/superadmin, show any booking
    if (userType === 'passenger') {
      query.passengerId = String(req.user?.id);
    }
    
    const item = await Booking.findOne(query).lean(); 
    if (!item) return res.status(404).json({ message: 'Booking not found or you do not have permission to access it' }); 
    // attach basic passenger info consistently
    const { Passenger } = require('../models/userModels');
    const { Types } = require('mongoose');
    let passenger = undefined;
    
    // Try to get passenger info from JWT token first
    if (req.user && req.user.id && req.user.type === 'passenger' && String(req.user.id) === String(item.passengerId)) {
      // The JWT token now contains passenger data directly
      passenger = {
        id: String(req.user.id),
        name: req.user.name || req.user.fullName || req.user.displayName,
        phone: req.user.phone || req.user.phoneNumber || req.user.mobile,
        email: req.user.email
      };
    }
    
    // Fallback to database lookup
    if (!passenger && item.passengerId && Types.ObjectId.isValid(item.passengerId)) {
      const p = await Passenger.findById(item.passengerId).select({ _id: 1, name: 1, phone: 1 }).lean();
      if (p) passenger = { id: String(p._id), name: p.name, phone: p.phone };
    }
    
    // Final fallback to stored passenger data
    if (!passenger && (item.passengerName || item.passengerPhone)) {
      passenger = { id: String(item.passengerId), name: item.passengerName, phone: item.passengerPhone };
    }
    
    // Generic fallback for testing
    if (!passenger) {
      passenger = { id: String(item.passengerId), name: `Passenger ${item.passengerId}`, phone: `+123456789${item.passengerId}` };
    }
    return res.json({
      id: String(item._id),
      passengerId: item.passengerId,
      passenger,
      vehicleType: item.vehicleType,
      pickup: item.pickup,
      dropoff: item.dropoff,
      distanceKm: item.distanceKm,
      fareEstimated: item.fareEstimated,
      fareFinal: item.fareFinal,
      fareBreakdown: item.fareBreakdown,
      status: item.status,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    }); 
  } catch (e) { 
    return res.status(500).json({ message: `Failed to retrieve booking: ${e.message}` }); 
  }
}

exports.update = async (req, res) => {
  try {
    const updated = await Booking.findOneAndUpdate({ _id: req.params.id, passengerId: String(req.user?.id) }, req.body, { new: true });
    if (!updated) return res.status(404).json({ message: 'Booking not found or you do not have permission to update it' });
    return res.json(updated);
  } catch (e) { return res.status(500).json({ message: `Failed to update booking: ${e.message}` }); }
}

exports.remove = async (req, res) => {
  try { 
    const r = await Booking.findOneAndDelete({ _id: req.params.id, passengerId: String(req.user?.id) }); 
    if (!r) return res.status(404).json({ message: 'Booking not found or you do not have permission to delete it' }); 
    return res.status(204).send(); 
  } catch (e) { 
    return res.status(500).json({ message: `Failed to delete booking: ${e.message}` }); 
  }
}

exports.lifecycle = async (req, res) => {
  try {
    const { status } = req.body;
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    if (!['requested','accepted','ongoing','completed','canceled'].includes(status)) return res.status(400).json({ message: `Invalid status '${status}'. Allowed values: requested, accepted, ongoing, completed, canceled` });
    
    // Prevent status changes on completed bookings
    if (booking.status === 'completed') {
      return res.status(400).json({ message: 'Cannot change status of completed bookings' });
    }
    
    // Check if driver is trying to accept booking
    if (status === 'accepted' && req.user?.type === 'driver') {
      const { Driver } = require('../models/userModels');
      const driver = await Driver.findById(req.user.id);
      if (!driver || !driver.available) {
        return res.status(400).json({ message: 'Driver must be available to accept bookings. Driver is currently unavailable.' });
      }
      
      // Check if driver already has an active booking
      const activeBooking = await Booking.findOne({ 
        driverId: req.user.id, 
        status: { $in: ['accepted', 'ongoing'] } 
      });
      if (activeBooking) {
        return res.status(400).json({ message: 'Driver already has an active booking' });
      }
      
      // Set driver ID and make driver unavailable
      booking.driverId = String(req.user.id);
      await Driver.findByIdAndUpdate(req.user.id, { available: false });
    }
    
    // Check if another driver is trying to change status of accepted booking
    if (req.user?.type === 'driver' && booking.driverId && booking.driverId !== String(req.user.id)) {
      return res.status(403).json({ message: 'Only the assigned driver can change this booking status' });
    }
    
    booking.status = status;
    if (status === 'accepted') { booking.acceptedAt = new Date(); }
    if (status === 'ongoing') { 
      booking.startedAt = new Date();
      // Start position tracking for ongoing trips
      if (booking.driverId && booking.passengerId) {
        positionUpdateService.startTracking(booking._id.toString(), booking.driverId, booking.passengerId);
      }
    }
    if (status === 'completed') { 
      booking.completedAt = new Date(); 
      booking.fareFinal = booking.fareEstimated;
      
      // Create earnings records
      if (booking.driverId) {
        const { DriverEarnings, AdminEarnings, Commission } = require('../models/commission');
        
        // Get current commission rate
        const commission = await Commission.findOne({ isActive: true }).sort({ createdAt: -1 });
        const commissionRate = commission ? commission.percentage : 15; // Default 15%
        
        const grossFare = booking.fareFinal || booking.fareEstimated;
        const commissionAmount = (grossFare * commissionRate) / 100;
        const netEarnings = grossFare - commissionAmount;
        
        // Create driver earnings record
        await DriverEarnings.create({
          driverId: booking.driverId,
          bookingId: booking._id,
          tripDate: new Date(),
          grossFare,
          commissionAmount,
          netEarnings,
          commissionPercentage: commissionRate
        });
        
        // Update driver wallet: increment balance and totalEarnings by netEarnings
        try {
          const mongoose = require('mongoose');
          const { Wallet, Transaction } = require('../models/common');
          const session = await mongoose.startSession();
          await session.withTransaction(async () => {
            console.log('[wallet] credit on booking completed:', { driverId: String(booking.driverId), netEarnings, bookingId: String(booking._id) });
            await Wallet.updateOne(
              { userId: String(booking.driverId), role: 'driver' },
              { $inc: { balance: netEarnings, totalEarnings: netEarnings } },
              { upsert: true, session }
            );
            await Transaction.create([
              {
                userId: String(booking.driverId),
                role: 'driver',
                amount: netEarnings,
                type: 'credit',
                method: booking.paymentMethod || 'cash',
                status: 'success',
                metadata: { bookingId: String(booking._id), reason: 'Trip earnings (REST)' }
              }
            ], { session });
          });
          session.endSession();
        } catch (e) { console.error('[wallet] credit on complete failed:', e); }

        // Create admin earnings record
        await AdminEarnings.create({
          bookingId: booking._id,
          tripDate: new Date(),
          grossFare,
          commissionEarned: commissionAmount,
          commissionPercentage: commissionRate,
          driverId: booking.driverId,
          passengerId: booking.passengerId
        });
        
        // Make driver available again when trip completes
        const { Driver } = require('../models/userModels');
        await Driver.findByIdAndUpdate(booking.driverId, { available: true });
        
        // Stop position tracking for completed trips
        positionUpdateService.stopTracking(booking._id.toString());
      }
    }
    if (status === 'canceled') {
      // Make driver available again when booking is canceled
      if (booking.driverId) {
        const { Driver } = require('../models/userModels');
        await Driver.findByIdAndUpdate(booking.driverId, { available: true });
      }
      
      // Stop position tracking for canceled trips
      positionUpdateService.stopTracking(booking._id.toString());
    }
    
    await booking.save();
    await TripHistory.create({ bookingId: booking._id, driverId: booking.driverId, passengerId: booking.passengerId, status: booking.status });
    broadcast('booking:update', { id: booking.id || String(booking._id || ''), status });
    return res.json(booking);
  } catch (e) { return res.status(500).json({ message: `Failed to update booking lifecycle: ${e.message}` }); }
}

exports.assign = async (req, res) => {
  try {
    const { driverId, dispatcherId, passengerId } = req.body;
    const bookingId = req.params.id;
    
    // Validate required fields
    if (!driverId) return res.status(400).json({ message: 'Driver ID is required for assignment' });
    if (!dispatcherId) return res.status(400).json({ message: 'Dispatcher ID is required for assignment' });
    
    const { Types } = require('mongoose');
    const booking = await Booking.findById(bookingId);
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    
    // Check if booking is already assigned or completed
    if (booking.status !== 'requested') {
      return res.status(400).json({ message: `Cannot assign booking with status '${booking.status}'. Only 'requested' bookings can be assigned.` });
    }
    
    // Check if driver is available
    const { Driver } = require('../models/userModels');
    const driver = await Driver.findById(driverId);
    if (!driver || !driver.available) {
      return res.status(400).json({ message: 'Driver is not available for assignment. Driver must be available to accept bookings.' });
    }
    
    // Check if driver already has an active booking
    const activeBooking = await Booking.findOne({ 
      driverId: String(driverId), 
      status: { $in: ['accepted', 'ongoing'] } 
    });
    if (activeBooking) {
      return res.status(400).json({ message: 'Driver already has an active booking' });
    }
    
    const assignment = await BookingAssignment.create({ 
      bookingId, 
      driverId: String(driverId), 
      dispatcherId: String(dispatcherId), 
      passengerId: String(passengerId || booking.passengerId) 
    });
    
    // Update booking and make driver unavailable
    booking.driverId = String(driverId); 
    booking.status = 'accepted'; 
    booking.acceptedAt = new Date(); 
    await booking.save();
    
    // Make driver unavailable
    await Driver.findByIdAndUpdate(driverId, { available: false });
    
    broadcast('booking:assigned', { bookingId, driverId });
    return res.json({ booking, assignment });
  } catch (e) { return res.status(500).json({ message: `Failed to assign booking: ${e.message}` }); }
}

exports.estimate = async (req, res) => {
  try {
    const { vehicleType, pickup, dropoff } = req.body;
    if (!pickup || !dropoff) return res.status(400).json({ message: 'Pickup and dropoff locations are required for fare estimation' });
    const est = await estimateFare({ vehicleType, pickup, dropoff });
    return res.json(est);
  } catch (e) { return res.status(500).json({ message: `Failed to estimate fare: ${e.message}` }); }
}

// GET /v1/bookings/nearby?latitude=...&longitude=...&radiusKm=5&vehicleType=mini&limit=20
exports.nearby = async (req, res) => {
  try {
    // Only drivers (or staff/admin) can view nearby available bookings
    const userType = req.user && req.user.type;
    if (!['driver','admin','staff','superadmin'].includes(String(userType || ''))) {
      return res.status(403).json({ message: 'Only drivers or staff can view nearby bookings' });
    }

    const latitude = parseFloat(req.query.latitude);
    const longitude = parseFloat(req.query.longitude);
    const radiusKm = parseFloat(req.query.radiusKm || '5');
    const vehicleType = req.query.vehicleType || undefined;
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);

    if (!isFinite(latitude) || !isFinite(longitude)) {
      return res.status(400).json({ message: 'Valid latitude and longitude are required' });
    }

    // Find only requested (unassigned) bookings optionally filtered by vehicleType
    const query = { status: 'requested', ...(vehicleType ? { vehicleType } : {}) };
    const rows = await Booking.find(query).sort({ createdAt: -1 }).lean();

    // Compute distances and filter within radius
    const withDistance = rows
      .map(b => {
        const dKm = geolib.getDistance(
          { latitude, longitude },
          { latitude: b.pickup?.latitude, longitude: b.pickup?.longitude }
        ) / 1000;
        return { booking: b, distanceKm: dKm };
      })
      .filter(x => isFinite(x.distanceKm) && x.distanceKm <= radiusKm);

    // Sort by distance and apply limit
    withDistance.sort((a, b) => a.distanceKm - b.distanceKm);
    const selected = withDistance.slice(0, limit);

    // Attach minimal passenger info if present in booking; do not expand externally here
    const result = selected.map(x => ({
      id: String(x.booking._id),
      passengerId: x.booking.passengerId,
      passenger: (x.booking.passengerName || x.booking.passengerPhone)
        ? { id: x.booking.passengerId, name: x.booking.passengerName, phone: x.booking.passengerPhone }
        : undefined,
      vehicleType: x.booking.vehicleType,
      pickup: x.booking.pickup,
      dropoff: x.booking.dropoff,
      distanceKm: Math.round(x.distanceKm * 100) / 100,
      fareEstimated: x.booking.fareEstimated,
      status: x.booking.status,
      createdAt: x.booking.createdAt,
      updatedAt: x.booking.updatedAt
    }));

    return res.json(result);
  } catch (e) {
    return res.status(500).json({ message: `Failed to retrieve nearby bookings: ${e.message}` });
  }
}

// Rate passenger (driver rates passenger after trip completion)
exports.ratePassenger = async (req, res) => {
  try {
    const { rating, comment } = req.body;
    const bookingId = req.params.id;
    const driverId = req.user.id;

    // Validate rating
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ message: 'Rating must be between 1 and 5' });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    // Check if the driver is authorized to rate this passenger
    if (booking.driverId !== driverId) {
      return res.status(403).json({ message: 'Only the assigned driver can rate the passenger' });
    }

    // Check if the trip is completed
    if (booking.status !== 'completed') {
      return res.status(400).json({ message: 'Can only rate after trip completion' });
    }

    // Update booking with passenger rating
    booking.passengerRating = rating;
    if (comment) booking.passengerComment = comment;
    await booking.save();

    return res.json({ 
      message: 'Passenger rated successfully', 
      booking: booking,
      rating: rating,
      comment: comment 
    });
  } catch (e) {
    return res.status(500).json({ message: `Failed to rate passenger: ${e.message}` });
  }
}

function isWithinRadiusKm(a, b, radiusKm) {
  if (!a || !b || a.latitude == null || a.longitude == null || b.latitude == null || b.longitude == null) return false;
  const d = geolib.getDistance({ latitude: a.latitude, longitude: a.longitude }, { latitude: b.latitude, longitude: b.longitude }) / 1000;
  return d <= radiusKm;
}

// Rate driver (passenger rates driver after trip completion)
exports.rateDriver = async (req, res) => {
  try {
    const { rating, comment } = req.body;
    const bookingId = req.params.id;
    const passengerId = req.user.id;

    // Validate rating
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ message: 'Rating must be between 1 and 5' });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    // Check if the passenger is authorized to rate this driver
    const equalIds = (a, b) => {
      if (!a || !b) return false;
      try { return String(a) === String(b); } catch (_) { return false; }
    };
    if (!equalIds(booking.passengerId, passengerId)) {
      return res.status(403).json({ message: 'Only the passenger can rate the driver' });
    }

    // Check if the trip is completed
    if (booking.status !== 'completed') {
      return res.status(400).json({ message: 'Can only rate after trip completion' });
    }

    // Update booking with driver rating
    booking.driverRating = rating;
    if (comment) booking.driverComment = comment;
    await booking.save();

    return res.json({ message: 'Driver rated successfully' });
  } catch (e) {
    return res.status(500).json({ message: `Failed to rate driver: ${e.message}` });
  }
}
