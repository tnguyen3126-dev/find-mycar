const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Simple file-backed / SQLite storage for locations and daily mileage
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_FILE = path.join(DATA_DIR, 'tracking.json');

// Memory cache + disk backup
let db = {
  latest: null,
  locations: [], // Rolling 7 days
  mileage: {}    // Daily km: { "2026-11-09": { distanceKm: 12.5, maxSpeed: 65, avgSpeed: 32 } }
};

if (fs.existsSync(DB_FILE)) {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    db = JSON.parse(raw);
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
  for (const dateKey of Object.keys(db.mileage)) {
    if (dateKey < cutoffMileage) {
      delete db.mileage[dateKey];
    }
  }
}

// 1. API: Android gửi dữ liệu vị trí lên server
app.post('/api/tracking', (req, res) => {
  const {
    deviceId,
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

  const point = {
    deviceId: deviceId || 'car_default',
    latitude: Number(latitude),
    longitude: Number(longitude),
    speed: Math.round(Number(speed)),
    networkType,
    battery: Math.round(Number(battery)),
    address,
    timestamp: Number(timestamp)
  };

  // Calculate distance from last point to add into today's mileage
  const todayKey = new Date(point.timestamp).toISOString().split('T')[0];
  if (!db.mileage[todayKey]) {
    db.mileage[todayKey] = {
      date: todayKey,
      distanceKm: 0,
      maxSpeed: point.speed,
      pointsCount: 0
    };
  }

  if (db.latest && db.latest.latitude && db.latest.longitude) {
    const dist = calculateDistance(db.latest.latitude, db.latest.longitude, point.latitude, point.longitude);
    // Ignore jump noise > 150 km/h or < 0.01 km
    if (dist > 0.01 && dist < 5.0) {
      db.mileage[todayKey].distanceKm = Number((db.mileage[todayKey].distanceKm + dist).toFixed(2));
    }
  }

  if (point.speed > db.mileage[todayKey].maxSpeed) {
    db.mileage[todayKey].maxSpeed = point.speed;
  }
  db.mileage[todayKey].pointsCount += 1;

  db.latest = point;
  db.locations.push(point);

  // Purge old entries
  purgeOldData();
  saveDb();

  return res.json({ success: true, message: 'Đã nhận tọa độ' });
});

// 2. API: Lấy tọa độ mới nhất (Live tracking)
app.get('/api/latest', (req, res) => {
  if (!db.latest) {
    return res.json({
      success: false,
      message: 'Chưa có dữ liệu nào từ thiết bị',
      data: null
    });
  }
  return res.json({ success: true, data: db.latest });
});

// 3. API: Lấy lộ trình xem lại theo ngày hoặc khoảng thời gian (tối đa 7 ngày)
app.get('/api/history', (req, res) => {
  const { date } = req.query; // YYYY-MM-DD
  let result = db.locations;

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

// 4. API: Lấy báo cáo Km tổng hợp theo tháng (30 ngày cuốn chiếu)
app.get('/api/mileage-report', (req, res) => {
  const sortedDates = Object.keys(db.mileage).sort().reverse();
  const report = sortedDates.map(d => db.mileage[d]);
  const totalMonthKm = report.reduce((sum, item) => sum + (item.distanceKm || 0), 0);

  return res.json({
    success: true,
    totalMonthKm: Number(totalMonthKm.toFixed(2)),
    days: report
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Car Tracker Server chạy tại: http://localhost:${PORT}`);
});
