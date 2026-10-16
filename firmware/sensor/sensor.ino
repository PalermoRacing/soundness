// Palermo Racing Diary — gait sensor firmware for M5StickS3
// One firmware for all three sticks. Press the front button (A) to choose what each stick is:
// HEAD (poll), PELVIS (top of the croup, between the hip bones) or R FORE (right fore pastern).
// The diary app connects over Bluetooth, starts/stops recording and downloads the data.
//
// Buttons:  A (front) short press  = change role (only when not recording)
//           A hold 2 s              = turn off
//           B (side) short press    = screen bright / dim

#include <M5Unified.h>
#include <Preferences.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <esp_timer.h>

#define FW_VERSION "1.0"

static const char* SERVICE_UUID = "7a1e0001-5c2b-4c7e-9d6a-50a1e2a0c0de";
static const char* CTRL_UUID    = "7a1e0002-5c2b-4c7e-9d6a-50a1e2a0c0de";   // app -> stick (text commands)
static const char* EVT_UUID     = "7a1e0003-5c2b-4c7e-9d6a-50a1e2a0c0de";   // stick -> app (text replies)
static const char* DATA_UUID    = "7a1e0004-5c2b-4c7e-9d6a-50a1e2a0c0de";   // stick -> app (binary samples)

static const char* ROLE_NAME[3]  = { "HEAD", "PELVIS", "R FORE" };
static const char* ROLE_CODE[3]  = { "HEAD", "PELV", "RFORE" };
static const uint16_t ROLE_COL[3] = { 0x1A7F /*blue*/, 0x2E8A /*green*/, 0xFC60 /*orange*/ };

// ---- recording buffer (PSRAM) ----
// Raw BMI270 values as they come out of its FIFO: gyro x,y,z then accel x,y,z.
// Accel ±16 g (2048 per g), gyro ±2000 dps (16.384 per dps). The sensor runs at 100 Hz.
struct __attribute__((packed)) Sample { int16_t gx, gy, gz, ax, ay, az; };
static const uint32_t MAX_SAMPLES = 100UL * 60UL * 6UL;   // 6 minutes at 100 Hz
static Sample* buf = nullptr;
static volatile uint32_t nSamples = 0;
static volatile bool recording = false;
static int64_t tFirst = 0, tLast = 0;          // esp_timer microseconds of first/last sample
static uint8_t imuAddr = 0x68;
static const uint32_t I2C_HZ = 400000;
static uint8_t fifoBuf[1040];
static size_t fifoLeft = 0;          // bytes of a partial frame carried over between reads

// ---- state ----
static Preferences prefs;
static int role = 0;
static BLEServer* server = nullptr;
static BLECharacteristic *chCtrl, *chEvt, *chData;
static volatile bool connected = false;
static bool wasConnected = false;
static volatile bool wantStatus = false;
static volatile bool wantStart = false, wantStop = false;
static volatile int wantRole = -1;
static volatile uint32_t readStart = 0, readCount = 0;   // pending download window
static volatile bool readPending = false;
static bool bright = true;
static uint32_t lastDraw = 0, lastStatus = 0;
static String lastScreen;

static void sendEvt(const String& s){
  if (!connected) return;
  chEvt->setValue(s);
  chEvt->notify();
}

static String statusLine(){
  char tmp[160];
  snprintf(tmp, sizeof(tmp), "S,%s,%d,%d,%lu,%lld,%lld,%s,%lld",
    ROLE_CODE[role], recording ? 1 : 0, (int)M5.Power.getBatteryLevel(), (unsigned long)nSamples,
    (long long)tFirst, (long long)tLast, FW_VERSION, (long long)esp_timer_get_time());
  return String(tmp);
}

// faster connection interval for downloads (iOS accepts 15–30 ms)
class ServerCB : public BLEServerCallbacks {
#if defined(CONFIG_NIMBLE_ENABLED)
  void onConnect(BLEServer* s, ble_gap_conn_desc* desc) override {
    connected = true; wantStatus = true;
    s->requestConnParams(desc->conn_handle, 12, 24, 0, 400);
  }
  void onDisconnect(BLEServer* s, ble_gap_conn_desc* desc) override { connected = false; readPending = false; }
#else
  void onConnect(BLEServer* s, esp_ble_gatts_cb_param_t* param) override {
    connected = true; wantStatus = true;
    s->requestConnParams(param->connect.remote_bda, 12, 24, 0, 400);
  }
  void onDisconnect(BLEServer* s, esp_ble_gatts_cb_param_t* param) override { connected = false; readPending = false; }
#endif
  void onConnect(BLEServer* s) override { connected = true; wantStatus = true; }
  void onDisconnect(BLEServer* s) override { connected = false; readPending = false; }
};

class CtrlCB : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* c) override {
    String v = c->getValue();
    v.trim();
    if (v.startsWith("PING:")){
      // answer straight away (used to line up the three sticks' clocks)
      String r = "P," + v.substring(5) + "," + String((long long)esp_timer_get_time());
      chEvt->setValue(r); chEvt->notify();
    } else if (v == "START"){ wantStart = true; }
    else if (v == "STOP"){ wantStop = true; }
    else if (v == "STATUS"){ wantStatus = true; }
    else if (v.startsWith("READ:")){
      int a = v.indexOf(':', 5);
      readStart = (uint32_t)v.substring(5, a).toInt();
      readCount = a > 0 ? (uint32_t)v.substring(a + 1).toInt() : 300;
      readPending = true;
    } else if (v.startsWith("ROLE:")){
      int r = v.substring(5).toInt();
      if (r >= 0 && r < 3) wantRole = r;
    }
  }
};

static void setRole(int r){
  prefs.putInt("role", r);
  delay(100);
  ESP.restart();   // the Bluetooth name includes the role, so restart to use the new name
}

static void drawScreen(bool force){
  auto& d = M5.Display;
  String state;
  if (recording){
    uint32_t s = nSamples / 100;
    char t[24]; snprintf(t, sizeof(t), "REC %02lu:%02lu", (unsigned long)(s / 60), (unsigned long)(s % 60));
    state = t;
  } else if (nSamples) state = "Recorded " + String(nSamples / 100) + "s";
  else state = "Ready";
  int batt = M5.Power.getBatteryLevel();
  String key = String(role) + state + (connected ? "c" : "n") + String(batt / 5);
  if (!force && key == lastScreen) return;
  lastScreen = key;
  d.startWrite();
  d.fillScreen(recording ? TFT_RED : ROLE_COL[role]);
  d.setTextColor(TFT_WHITE);
  d.setTextDatum(middle_center);
  d.setFont(&fonts::FreeSansBold18pt7b);
  d.drawString(ROLE_NAME[role], d.width() / 2, 44);
  d.setFont(&fonts::FreeSans12pt7b);
  d.drawString(state, d.width() / 2, 88);
  d.setFont(&fonts::FreeSans9pt7b);
  d.setTextDatum(bottom_left);
  d.drawString(connected ? "Connected" : "Waiting for app", 6, d.height() - 4);
  d.setTextDatum(bottom_right);
  d.drawString(String(batt) + "%", d.width() - 6, d.height() - 4);
  d.endWrite();
}

static void sendChunk(uint32_t start, uint32_t count){
  // [uint32 start index][N samples x 12 bytes]; 14 samples fits the iPhone's 185-byte packets
  const uint32_t PER = 14;
  uint8_t pkt[4 + PER * sizeof(Sample)];
  uint32_t end = start + count; if (end > nSamples) end = nSamples;
  for (uint32_t i = start; i < end && connected; i += PER){
    uint32_t n = end - i < PER ? end - i : PER;
    memcpy(pkt, &i, 4);
    memcpy(pkt + 4, &buf[i], n * sizeof(Sample));
    chData->setValue(pkt, 4 + n * sizeof(Sample));
    chData->notify();
    delay(8);   // give the radio time so packets aren't dropped
  }
  sendEvt("D," + String(start) + "," + String(end));   // window finished
}

static bool imuW(uint8_t reg, uint8_t v){ return M5.In_I2C.writeRegister8(imuAddr, reg, v, I2C_HZ); }
static uint8_t imuR(uint8_t reg){ return M5.In_I2C.readRegister8(imuAddr, reg, I2C_HZ); }

static bool imuSetup(){
  // M5Unified has already loaded the BMI270's start-up file; find it and set it up for recording
  imuAddr = 0x68; if (imuR(0x00) != 0x24){ imuAddr = 0x69; if (imuR(0x00) != 0x24) return false; }
  imuW(0x7D, 0x0E);   // PWR_CTRL: accel + gyro + temperature on
  delay(2);
  imuW(0x40, 0xA8);   // ACC_CONF: 100 Hz, normal filter, performance mode
  imuW(0x41, 0x03);   // ACC_RANGE: ±16 g (hoof strikes are hard)
  imuW(0x42, 0xA8);   // GYR_CONF: 100 Hz, normal filter, performance mode
  imuW(0x43, 0x00);   // GYR_RANGE: ±2000 dps
  imuW(0x45, 0x88);   // FIFO_DOWNS: filtered data into the FIFO
  imuW(0x48, 0x00);   // FIFO_CONFIG_0: keep newest data, no time frames
  imuW(0x49, 0xD0);   // FIFO_CONFIG_1: gyro + accel, with headers
  delay(2);
  return true;
}
static void fifoFlush(){ imuW(0x7E, 0xB0); fifoLeft = 0; }

static void addSample(const uint8_t* p){
  if (nSamples >= MAX_SAMPLES){ recording = false; wantStatus = true; return; }
  memcpy(&buf[nSamples], p, sizeof(Sample));
  nSamples = nSamples + 1;
}

// Read whatever is waiting in the sensor's FIFO (it holds about 1.5 s of data, so a slow
// screen update never loses samples) and add it to the recording.
static void fifoRead(){
  uint8_t l[2];
  if (!M5.In_I2C.readRegister(imuAddr, 0x24, l, 2, I2C_HZ)) return;
  size_t len = ((l[1] & 0x3F) << 8) | l[0];
  if (len == 0) return;
  int64_t now = esp_timer_get_time();
  while (len > 0){
    size_t want = len > 1024 - fifoLeft ? 1024 - fifoLeft : len;
    if (!M5.In_I2C.readRegister(imuAddr, 0x26, fifoBuf + fifoLeft, want, I2C_HZ)) return;
    len -= want;
    size_t n = fifoLeft + want, i = 0;
    uint32_t before = nSamples;
    while (i < n){
      uint8_t h = fifoBuf[i];
      if (h == 0x8C){                    // gyro + accel frame
        if (i + 13 > n) break;
        if (recording) addSample(&fifoBuf[i + 1]);
        i += 13;
      } else if (h == 0x84 || h == 0x88){ // accel-only or gyro-only frame (only while settings change)
        if (i + 7 > n) break; i += 7;
      } else if (h == 0x40){             // skip frame: the FIFO overflowed, repeat the last sample to keep time
        if (i + 2 > n) break;
        uint8_t k = fifoBuf[i + 1];
        for (uint8_t j = 0; j < k && recording && nSamples; j++) addSample((const uint8_t*)&buf[nSamples - 1]);
        i += 2;
      } else if (h == 0x48){ if (i + 5 > n) break; i += 5; }   // settings-changed frame
      else if (h == 0x44){ if (i + 4 > n) break; i += 4; }     // sensor time frame
      else { i = n; break; }                                   // 0x80 = empty, or unknown: stop
    }
    fifoLeft = n - i;
    if (fifoLeft) memmove(fifoBuf, fifoBuf + i, fifoLeft);
    if (recording && nSamples > before){
      if (before == 0) tFirst = now - (int64_t)(nSamples - 1) * 10000;   // first sample time
      tLast = now;
    }
  }
}

void setup(){
  auto cfg = M5.config();
  M5.begin(cfg);
  M5.Display.setRotation(1);
  M5.Display.setBrightness(120);

  prefs.begin("gait", false);
  role = prefs.getInt("role", 0);
  if (role < 0 || role > 2) role = 0;

  buf = (Sample*)ps_malloc(MAX_SAMPLES * sizeof(Sample));
  bool imuOk = imuSetup();
  if (!buf || !imuOk){
    M5.Display.fillScreen(TFT_RED);
    M5.Display.setTextDatum(middle_center);
    M5.Display.drawString(!buf ? "No PSRAM" : "No motion sensor", M5.Display.width() / 2, M5.Display.height() / 2);
    while (true) delay(1000);
  }

  String name = String("PRD-") + ROLE_CODE[role];
  BLEDevice::init(name.c_str());
  BLEDevice::setMTU(247);
  server = BLEDevice::createServer();
  server->setCallbacks(new ServerCB());
  server->advertiseOnDisconnect(true);
  BLEService* svc = server->createService(SERVICE_UUID);
  chCtrl = svc->createCharacteristic(CTRL_UUID, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  chCtrl->setCallbacks(new CtrlCB());
  chEvt = svc->createCharacteristic(EVT_UUID, BLECharacteristic::PROPERTY_NOTIFY | BLECharacteristic::PROPERTY_READ);
  chEvt->addDescriptor(new BLE2902());
  chData = svc->createCharacteristic(DATA_UUID, BLECharacteristic::PROPERTY_NOTIFY);
  chData->addDescriptor(new BLE2902());
  svc->start();
  BLEAdvertising* adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(SERVICE_UUID);
  adv->setScanResponse(true);
  adv->setMinPreferred(0x06);
  adv->setMaxPreferred(0x12);
  BLEDevice::startAdvertising();

  drawScreen(true);
}

void loop(){
  // ---- IMU: empty the sensor's FIFO every 40 ms ----
  static uint32_t lastFifo = 0;
  if (millis() - lastFifo >= 40){ lastFifo = millis(); fifoRead(); }

  uint32_t ms = millis();
  static uint32_t lastBtn = 0;
  if (ms - lastBtn >= 20){
    lastBtn = ms;
    M5.update();
    if (M5.BtnA.pressedFor(2000)){
      M5.Display.fillScreen(TFT_BLACK);
      M5.Display.setTextDatum(middle_center);
      M5.Display.drawString("Turning off", M5.Display.width() / 2, M5.Display.height() / 2);
      delay(600);
      M5.Power.powerOff();
    }
    if (M5.BtnA.wasReleased() && !recording) setRole((role + 1) % 3);
    if (M5.BtnB.wasClicked()){ bright = !bright; M5.Display.setBrightness(bright ? 120 : 20); }
  }

  if (wantStart){
    wantStart = false;
    nSamples = 0; tFirst = tLast = 0; fifoFlush(); recording = true;
    wantStatus = true;
  }
  if (wantStop){ wantStop = false; fifoRead(); recording = false; wantStatus = true; }
  if (wantRole >= 0 && !recording){ int r = wantRole; wantRole = -1; sendEvt("R," + String(r)); delay(200); setRole(r); }

  if (connected && !wasConnected){ wasConnected = true; lastScreen = ""; }
  if (!connected && wasConnected){ wasConnected = false; lastScreen = ""; }

  if (readPending && !recording){
    readPending = false;
    sendChunk(readStart, readCount);
  }

  if (connected && (wantStatus || ms - lastStatus > 1000)){
    wantStatus = false; lastStatus = ms;
    sendEvt(statusLine());
  }
  if (ms - lastDraw > 500){ lastDraw = ms; drawScreen(false); }
}
