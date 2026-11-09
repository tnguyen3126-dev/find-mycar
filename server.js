const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Simple file-backed storage
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_FILE = path.join(DATA_DIR, 'tracking.json');

// Memory cache + disk backup
let db = {
  adminUser: {
    username: process.env.ADMIN_USER || 'admin',
    password: process.env.ADMIN_PASSWORD || 'admin123'
  },
  devices: [
    {
      id: 'car_default',
      name: 'Xe Ô Tô Của Bạn',
      plateNumber: '51K-999.88',
      type: 'car',
      createdAt: Date.now()
    }
  ],
  latestByDevice: {}, // { "car_default": { ... } }
  locations: [],      // Rolling 7 days: [ { deviceId, latitude, longitude, speed, ... } ]
  mileageByDevice: {} // { "car_default": { "2026-11-09": { distanceKm, maxSpeed } } }
};

if (fs.existsSync(DB_FILE)) {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const loaded = JSON.parse(raw);
    db = { ...db, ...loaded };
    if (!db.devices || db.devices.length === 0) {
      db.devices = [
        {
          id: 'car_default',
          name: 'Xe Ô Tô Của Bạn',
          plateNumber: '51K-999.88',
          type: 'car',
          createdAt: Date.now()
        }
      ];
    }
    if (!db.latestByDevice) db.latestByDevice = {};
    if (!db.mileageByDevice) db.mileageByDevice = {};
  } catch (e) {
    console.error('Error loading db file, initializing new:', e);
  }
}

function saveDb() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error('Error saving db:', e);
  }
}

// Simple token authentication
const activeTokens = new Set(['admin_token_master_2026']);

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ success: false, message: 'Yêu cầu đăng nhập để truy cập' });
  }
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (activeTokens.has(token)) {
    next();
  } else {
    res.status(401).json({ success: false, message: 'Phiên đăng nhập hết hạn hoặc không hợp lệ' });
  }
}

// Haversine formula to compute distance in km
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Clean rolling data: 7 days for route, 30 days for daily mileage
function purgeOldData() {
  const now = Date.now();
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

  // Purge locations older than 7 days
  const cutoffLocations = now - SEVEN_DAYS_MS;
  db.locations = db.locations.filter(p => p.timestamp >= cutoffLocations);

  // Purge mileage older than 30 days
  const cutoffMileage = new Date(now - THIRTY_DAYS_MS).toISOString().split('T')[0];
  for (const devId of Object.keys(db.mileageByDevice)) {
    for (const dateKey of Object.keys(db.mileageByDevice[devId] || {})) {
      if (dateKey < cutoffMileage) {
        delete db.mileageByDevice[devId][dateKey];
      }
    }
  }
}

// === AUTHENTICATION APIS ===
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (username === db.adminUser.username && password === db.adminUser.password) {
    const token = 'token_' + Math.random().toString(36).substring(2) + Date.now().toString(36);
    activeTokens.add(token);
    return res.json({
      success: true,
      token,
      user: { username: db.adminUser.username }
    });
  }
  return res.status(401).json({ success: false, message: 'Sai tên đăng nhập hoặc mật khẩu!' });
});

app.post('/api/auth/logout', (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const token = authHeader.replace(/^Bearer\s+/i, '');
    activeTokens.delete(token);
  }
  return res.json({ success: true, message: 'Đã đăng xuất' });
});

app.get('/api/auth/verify', requireAuth, (req, res) => {
  res.json({ success: true, message: 'Phiên hợp lệ' });
});

// === DEVICE MANAGEMENT APIS ===
app.get('/api/devices', requireAuth, (req, res) => {
  const list = db.devices.map(dev => {
    const latest = db.latestByDevice[dev.id] || null;
    return {
      ...dev,
      latest
    };
  });
  res.json({ success: true, data: list });
});

app.post('/api/devices', requireAuth, (req, res) => {
  const { id, name, plateNumber, type = 'car' } = req.body;
  if (!id || !name) {
    return res.status(400).json({ success: false, message: 'Thiếu ID thiết bị hoặc Tên thiết bị' });
  }

  const existingIndex = db.devices.findIndex(d => d.id === id);
  if (existingIndex >= 0) {
    db.devices[existingIndex] = {
      ...db.devices[existingIndex],
      name,
      plateNumber: plateNumber || db.devices[existingIndex].plateNumber,
      type
    };
  } else {
    db.devices.push({
      id: id.trim(),
      name: name.trim(),
      plateNumber: plateNumber ? plateNumber.trim() : 'Chưa có biển số',
      type,
      createdAt: Date.now()
    });
  }

  saveDb();
  res.json({ success: true, message: 'Đã lưu thiết bị thành công' });
});

app.delete('/api/devices/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  db.devices = db.devices.filter(d => d.id !== id);
  delete db.latestByDevice[id];
  delete db.mileageByDevice[id];
  db.locations = db.locations.filter(p => p.deviceId !== id);
  saveDb();
  res.json({ success: true, message: 'Đã xóa thiết bị' });
});

// === 1. API: Android gửi dữ liệu vị trí lên server (Không chặn Auth để thiết bị đẩy dữ liệu mượt mà) ===
app.post('/api/tracking', (req, res) => {
  const {
    deviceId = 'car_default',
    latitude,
    longitude,
    speed = 0,         // km/h
    networkType = '4G', // 'WiFi', '4G', '5G'
    battery = 100,      // %
    address = '',
    timestamp = Date.now()
  } = req.body;

  if (latitude === undefined || longitude === undefined) {
    return res.status(400).json({ error: 'Thiếu latitude hoặc longitude' });
  }

  // Tự động thêm thiết bị nếu chưa có trong danh sách
  if (!db.devices.some(d => d.id === deviceId)) {
    db.devices.push({
      id: deviceId,
      name: `Xe ${deviceId}`,
      plateNumber: 'Đang kết nối',
      type: 'car',
      createdAt: Date.now()
    });
  }

  const point = {
    deviceId,
    latitude: Number(latitude),
    longitude: Number(longitude),
    speed: Math.round(Number(speed)),
    networkType,
    battery: Math.round(Number(battery)),
    address,
    timestamp: Number(timestamp)
  };

  // Tính quãng đường tích lũy cho ngày hôm nay của xe này
  if (!db.mileageByDevice[deviceId]) {
    db.mileageByDevice[deviceId] = {};
  }
  const todayKey = new Date(point.timestamp).toISOString().split('T')[0];
  if (!db.mileageByDevice[deviceId][todayKey]) {
    db.mileageByDevice[deviceId][todayKey] = {
      date: todayKey,
      distanceKm: 0,
      maxSpeed: point.speed,
      pointsCount: 0
    };
  }

  const lastPos = db.latestByDevice[deviceId];
  if (lastPos && lastPos.latitude && lastPos.longitude) {
    const dist = calculateDistance(lastPos.latitude, lastPos.longitude, point.latitude, point.longitude);
    if (dist > 0.008 && dist < 5.0) {
      db.mileageByDevice[deviceId][todayKey].distanceKm = Number(
        (db.mileageByDevice[deviceId][todayKey].distanceKm + dist).toFixed(2)
      );
    }
  }

  if (point.speed > db.mileageByDevice[deviceId][todayKey].maxSpeed) {
    db.mileageByDevice[deviceId][todayKey].maxSpeed = point.speed;
  }
  db.mileageByDevice[deviceId][todayKey].pointsCount += 1;

  db.latestByDevice[deviceId] = point;
  db.locations.push(point);

  purgeOldData();
  saveDb();

  return res.json({ success: true, message: 'Đã nhận tọa độ' });
});

// === 2. API: Lấy tọa độ mới nhất của 1 thiết bị hoặc tất cả ===
app.get('/api/latest', requireAuth, (req, res) => {
  const { deviceId } = req.query;
  if (deviceId) {
    const data = db.latestByDevice[deviceId] || null;
    return res.json({ success: true, data });
  }

  // Nếu không truyền deviceId, lấy thiết bị đầu tiên
  const firstId = db.devices[0]?.id || 'car_default';
  const data = db.latestByDevice[firstId] || null;
  return res.json({ success: true, data, deviceId: firstId });
});

// === 3. API: Lộ trình 7 ngày của thiết bị ===
app.get('/api/history', requireAuth, (req, res) => {
  const { deviceId = 'car_default', date } = req.query;
  let result = db.locations.filter(p => p.deviceId === deviceId);

  if (date) {
    const start = new Date(`${date}T00:00:00Z`).getTime();
    const end = new Date(`${date}T23:59:59Z`).getTime();
    result = result.filter(p => p.timestamp >= start && p.timestamp <= end);
  }

  return res.json({
    success: true,
    count: result.length,
    data: result
  });
});

// === 4. API: Báo cáo kilomet cuốn chiếu 30 ngày của thiết bị ===
app.get('/api/mileage-report', requireAuth, (req, res) => {
  const { deviceId = 'car_default' } = req.query;
  const devMileage = db.mileageByDevice[deviceId] || {};
  const sortedDates = Object.keys(devMileage).sort().reverse();
  const report = sortedDates.map(d => devMileage[d]);
  const totalMonthKm = report.reduce((sum, item) => sum + (item.distanceKm || 0), 0);

  return res.json({
    success: true,
    deviceId,
    totalMonthKm: Number(totalMonthKm.toFixed(2)),
    days: report
  });
});

// === 5. API: Reverse Geocoding chi tiết tiếng Việt chuẩn xác ===
app.get('/api/reverse-geocode', async (req, res) => {
  const { lat, lon } = req.query;
  if (!lat || !lon) {
    return res.status(400).json({ success: false, message: 'Thiếu lat hoặc lon' });
  }

  try {
    const fetchFn = globalThis.fetch || ((...args) => import('node-fetch').then(({ default: f }) => f(...args)));
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&addressdetails=1&accept-language=vi`;
    
    const response = await fetchFn(url, {
      headers: { 'User-Agent': 'FindMyCarTrackerApp/1.0' }
    });
    const data = await response.json();

    if (data && data.address) {
      const a = data.address;
      const parts = [];

      // Số nhà
      if (a.house_number) parts.push(`Số ${a.house_number}`);
      // Tên tòa nhà/địa điểm
      if (a.building || a.amenity || a.shop) parts.push(a.building || a.amenity || a.shop);
      // Đường phố
      if (a.road) parts.push(a.road.startsWith('Đường') ? a.road : `Đường ${a.road}`);
      // Phường / Xã
      if (a.suburb || a.quarter || a.neighbourhood || a.village) {
        const sub = a.suburb || a.quarter || a.neighbourhood || a.village;
        parts.push(sub.startsWith('Phường') || sub.startsWith('Xã') ? sub : `Phường ${sub}`);
      }
      // Quận / Huyện / Thị xã
      if (a.city_district || a.district || a.county || a.town) {
        const dist = a.city_district || a.district || a.county || a.town;
        parts.push(dist.startsWith('Quận') || dist.startsWith('Huyện') ? dist : `Quận ${dist}`);
      }
      // Tỉnh / Thành phố
      if (a.city || a.state) {
        parts.push(a.city || a.state);
      }

      const fullAddress = parts.join(', ');
      return res.json({
        success: true,
        address: fullAddress || data.display_name,
        raw: a
      });
    }

    return res.json({
      success: true,
      address: data.display_name || `Tọa độ: ${lat}, ${lon}`
    });
  } catch (err) {
    return res.json({
      success: false,
      address: `Tọa độ: ${lat}, ${lon}`
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Car Tracker Server chạy tại: http://localhost:${PORT}`);
});
