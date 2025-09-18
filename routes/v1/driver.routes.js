const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/driver.controller');
const walletCtrl = require('../../controllers/driverWallet.controller');
const { authenticate, authorize } = require('../../middleware/auth');

// Remove driver creation via API
router.get('/', authenticate, authorize('admin','staff'), ctrl.list);
router.get('/available', authenticate, ctrl.availableNearby);
router.get('/:id', authenticate, authorize('admin','staff'), ctrl.get);
// Driver self-service
// Driver self-service (id inferred from token; param ignored)
router.post('/:id/availability', authenticate, authorize('driver'), ctrl.setAvailability);
router.post('/:id/location', authenticate, authorize('driver'), ctrl.updateLocation);
// Driver wallet endpoints
router.get('/:id/wallet', authenticate, authorize('driver','admin','superadmin'), walletCtrl.getWallet);
router.get('/:id/wallet/transactions', authenticate, authorize('driver','admin','superadmin'), walletCtrl.listTransactions);
router.post('/:id/wallet/withdraw', authenticate, authorize('driver'), walletCtrl.withdraw);
router.post('/:id/wallet/adjust', authenticate, authorize('admin','superadmin'), walletCtrl.adjustBalance);
// Map external user service id to internal driver
router.post('/:id/set-external-id', authenticate, authorize('admin','staff'), async (req, res) => {
  try {
    const { Driver } = require('../../models/userModels');
    const driverId = req.params.id;
    const { externalId } = req.body || {};
    if (!externalId) return res.status(400).json({ message: 'externalId is required' });
    const d = await Driver.findByIdAndUpdate(driverId, { $set: { externalId: String(externalId) } }, { new: true });
    if (!d) return res.status(404).json({ message: 'Driver not found' });
    return res.json({ id: String(d._id), externalId: d.externalId });
  } catch (e) { return res.status(500).json({ message: e.message }); }
});

// Fare estimation endpoints
router.post('/estimate-fare', authenticate, authorize('passenger'), ctrl.estimateFareForPassenger);
router.get('/estimate-fare/:bookingId', authenticate, authorize('driver'), ctrl.estimateFareForDriver);

// Combined discover + estimate
router.post('/discover-and-estimate', authenticate, ctrl.discoverAndEstimate);

module.exports = router;

