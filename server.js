const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

// Konfigurasi Port Server (bisa diubah lewat environment variable PORT=8080 node server.js)
const PORT = process.env.PORT || 3000;

// Direktori utama projek di /home/<nama-projek> (fallback ke ./projects jika /home tidak tersedia)
const PROJECTS_ROOT = fs.existsSync('/DATA/projek') ? '/home' : path.join(__dirname, 'projects');
if (!fs.existsSync(PROJECTS_ROOT)) {
    fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
}

// Menyimpan proses terminal yang sedang berjalan agar bisa dihentikan (Ctrl+C)
const activeTerminals = new Map();

// Variabel state untuk menghitung persentase CPU secara akurat antar-interval
let prevCpuInfo = getRawCpuTimes();

// Cache ringan untuk perintah shell agar tidak membebani I/O storage eMMC
let storageCache = { data: null, timestamp: 0 };
let processCache = { data: [], timestamp: 0 };

// Penjaga Anti-Crash: Mencegah server mati mendadak saat terjadi gangguan jaringan/I/O sesaat
process.on('uncaughtException', (err) => {
    console.error('[Anti-Crash] Menangani error tak terduga:', err.message);
});

process.on('unhandledRejection', (reason) => {
    console.error('[Anti-Crash] Menangani promise rejection:', reason);
});

/**
 * Mengambil waktu CPU mentah dari /proc/stat (Linux) atau os.cpus()
 */
function getRawCpuTimes() {
    try {
        if (fs.existsSync('/proc/stat')) {
            const stat = fs.readFileSync('/proc/stat', 'utf8');
            const firstLine = stat.split('\n')[0];
            const parts = firstLine.trim().split(/\s+/).slice(1).map(Number);
            // user, nice, system, idle, iowait, irq, softirq, steal
            const idle = (parts[3] || 0) + (parts[4] || 0);
            const total = parts.reduce((acc, val) => acc + (val || 0), 0);
            return { idle, total };
        }
    } catch (err) {
        // Abaikan dan gunakan fallback os.cpus()
    }

    const cpus = os.cpus();
    let idle = 0;
    let total = 0;
    for (const cpu of cpus) {
        for (const type in cpu.times) {
            total += cpu.times[type];
        }
        idle += cpu.times.idle;
    }
    return { idle, total };
}

/**
 * Menghitung persentase pemakaian CPU & Load Average
 */
function getCpuMetrics() {
    const currentCpuInfo = getRawCpuTimes();
    const idleDiff = currentCpuInfo.idle - prevCpuInfo.idle;
    const totalDiff = currentCpuInfo.total - prevCpuInfo.total;
    prevCpuInfo = currentCpuInfo;

    let usage = 0;
    if (totalDiff > 0) {
        usage = ((totalDiff - idleDiff) / totalDiff) * 100;
    }
    usage = Math.max(0, Math.min(100, Number(usage.toFixed(1))));

    const cpus = os.cpus();
    const loadAvg = os.loadavg();

    return {
        usage,
        cores: cpus.length || 4,
        model: (cpus[0] && cpus[0].model) ? cpus[0].model.trim() : 'ARMv8 SoC Processor',
        load1m: Number(loadAvg[0].toFixed(2)),
        load5m: Number(loadAvg[1].toFixed(2)),
        load15m: Number(loadAvg[2].toFixed(2))
    };
}

/**
 * Mengambil statistik RAM & Swap dari /proc/meminfo (akurat untuk Linux/Armbian)
 */
function getMemoryMetrics() {
    let totalBytes = os.totalmem();
    let availableBytes = os.freemem();
    let swapTotal = 0;
    let swapFree = 0;

    try {
        if (fs.existsSync('/proc/meminfo')) {
            const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
            const parseKb = (key) => {
                const match = meminfo.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm'));
                return match ? parseInt(match[1], 10) * 1024 : 0;
            };
            const mTotal = parseKb('MemTotal');
            const mAvail = parseKb('MemAvailable') || parseKb('MemFree');
            if (mTotal > 0) {
                totalBytes = mTotal;
                availableBytes = mAvail;
            }
            swapTotal = parseKb('SwapTotal');
            swapFree = parseKb('SwapFree');
        }
    } catch (err) {
        // Fallback ke nilai os.totalmem() & os.freemem()
    }

    const usedBytes = Math.max(0, totalBytes - availableBytes);
    const percent = totalBytes > 0 ? Number(((usedBytes / totalBytes) * 100).toFixed(1)) : 0;
    const swapUsed = Math.max(0, swapTotal - swapFree);
    const swapPercent = swapTotal > 0 ? Number(((swapUsed / swapTotal) * 100).toFixed(1)) : 0;

    return {
        total: totalBytes,
        used: usedBytes,
        available: availableBytes,
        percent,
        swapTotal,
        swapUsed,
        swapPercent
    };
}

/**
 * Mengambil kapasitas Storage eMMC/SDCard menggunakan perintah df
 */
function getStorageMetrics() {
    const now = Date.now();
    if (storageCache.data && (now - storageCache.timestamp < 10000)) {
        return storageCache.data;
    }

    try {
        const output = execSync('df -B1 /', { encoding: 'utf8', timeout: 1500 });
        const lines = output.trim().split('\n');
        if (lines.length >= 2) {
            const parts = lines[1].trim().split(/\s+/);
            const total = parseInt(parts[1], 10) || 0;
            const used = parseInt(parts[2], 10) || 0;
            const available = parseInt(parts[3], 10) || 0;
            const percent = total > 0 ? Number(((used / total) * 100).toFixed(1)) : 0;
            const data = { total, used, available, percent, mount: '/' };
            storageCache = { data, timestamp: now };
            return data;
        }
    } catch (err) {
        // Abaikan jika gagal membaca df
    }

    return { total: 0, used: 0, available: 0, percent: 0, mount: '/' };
}

/**
 * Membaca sensor suhu SoC Armbian (/sys/class/thermal/thermal_zone0/temp)
 */
function getTemperatureMetrics() {
    const thermalPaths = [
        '/sys/class/thermal/thermal_zone0/temp',
        '/sys/class/thermal/thermal_zone1/temp',
        '/sys/class/hwmon/hwmon0/temp1_input'
    ];

    for (const filePath of thermalPaths) {
        try {
            if (fs.existsSync(filePath)) {
                const raw = parseFloat(fs.readFileSync(filePath, 'utf8').trim());
                if (!isNaN(raw) && raw > 0) {
                    const celsius = raw > 1000 ? raw / 1000 : raw;
                    return {
                        celsius: Number(celsius.toFixed(1)),
                        source: path.basename(path.dirname(filePath))
                    };
                }
            }
        } catch (err) {
            // Lanjut ke path berikutnya
        }
    }

    return { celsius: 45.0, source: 'Estimasi (Sensor tidak terbaca)' };
}

/**
 * Membaca sensor daya (jika ada PMIC) atau menghitung estimasi dinamis STB (5V / 12V)
 */
function getPowerMetrics(cpuUsage, adapterVolt) {
    try {
        const psDir = '/sys/class/power_supply';
        if (fs.existsSync(psDir)) {
            const supplies = fs.readdirSync(psDir);
            for (const sup of supplies) {
                const voltPath = path.join(psDir, sup, 'voltage_now');
                const currPath = path.join(psDir, sup, 'current_now');
                if (fs.existsSync(voltPath) && fs.existsSync(currPath)) {
                    const volt = parseFloat(fs.readFileSync(voltPath, 'utf8')) / 1e6;
                    const ampere = Math.abs(parseFloat(fs.readFileSync(currPath, 'utf8'))) / 1e6;
                    if (volt > 0 && ampere >= 0) {
                        const watt = volt * ampere;
                        const kwhMonth = (watt / 1000) * 24 * 30;
                        return {
                            mode: `Sensor Hardware (${sup})`,
                            volt: Number(volt.toFixed(2)),
                            ampere: Number(ampere.toFixed(2)),
                            watt: Number(watt.toFixed(2)),
                            monthlyCostIdr: Math.round(kwhMonth * 1445)
                        };
                    }
                }
            }
        }
    } catch (err) {
        // Fallback ke profil estimasi STB
    }

    // Estimasi realistis STB ARM (idle ~2.2W, full load ~4.8W)
    const volt = adapterVolt === 12 ? 12.0 : 5.0;
    const watt = 2.2 + (cpuUsage / 100) * 2.6;
    const ampere = watt / volt;
    const kwhMonth = (watt / 1000) * 24 * 30;

    return {
        mode: `Profil Adaptor ${volt}V DC`,
        volt: Number(volt.toFixed(2)),
        ampere: Number(ampere.toFixed(2)),
        watt: Number(watt.toFixed(2)),
        monthlyCostIdr: Math.round(kwhMonth * 1445)
    };
}

/**
 * Mengambil informasi Sistem Operasi Armbian, IP Lokal, Status WiFi/LAN, & Uptime
 */
function getSystemInfo() {
    let osName = `${os.type()} ${os.release()}`;
    try {
        if (fs.existsSync('/etc/os-release')) {
            const osRelease = fs.readFileSync('/etc/os-release', 'utf8');
            const prettyMatch = osRelease.match(/^PRETTY_NAME="?(.*?)"?$/m);
            if (prettyMatch && prettyMatch[1]) {
                osName = prettyMatch[1];
            }
        }
    } catch (err) {
        // Gunakan default osName
    }

    // Ambil alamat IPv4 lokal & nama interface (eth0 / wlan0)
    let localIp = 'Menunggu Jaringan...';
    let netInterface = 'offline';
    let isNetworkUp = false;

    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                localIp = net.address;
                netInterface = name;
                isNetworkUp = true;
                break;
            }
        }
        if (isNetworkUp) break;
    }

    // Cek kualitas sinyal WiFi jika menggunakan wlan (dari /proc/net/wireless)
    let wifiSignal = null;
    try {
        if (fs.existsSync('/proc/net/wireless')) {
            const wireless = fs.readFileSync('/proc/net/wireless', 'utf8');
            const lines = wireless.trim().split('\n');
            if (lines.length >= 3) {
                const parts = lines[2].trim().split(/\s+/);
                const linkQuality = parseFloat(parts[2]); // biasanya skala 0 - 70
                if (!isNaN(linkQuality)) {
                    wifiSignal = Math.min(100, Math.round((linkQuality / 70) * 100));
                }
            }
        }
    } catch (err) {
        // Abaikan jika memakai kabel LAN (eth0)
    }

    return {
        hostname: os.hostname(),
        osName,
        kernel: os.release(),
        arch: os.arch(),
        platform: os.platform(),
        ip: localIp,
        netInterface,
        isNetworkUp,
        wifiSignal,
        uptimeSeconds: os.uptime()
    };
}

/**
 * Mengambil 5 proses teratas berdasarkan penggunaan RAM (berguna untuk memantau Bot & Web)
 */
function getTopProcesses() {
    const now = Date.now();
    if (processCache.data.length > 0 && (now - processCache.timestamp < 4000)) {
        return processCache.data;
    }

    try {
        const out = execSync('ps -eo pid,comm,%cpu,%mem --sort=-%mem | head -n 6', {
            encoding: 'utf8',
            timeout: 1500
        });
        const lines = out.trim().split('\n').slice(1);
        const list = lines.map(line => {
            const parts = line.trim().split(/\s+/);
            return {
                pid: parts[0],
                name: parts[1],
                cpu: parts[2] + '%',
                mem: parts[3] + '%'
            };
        });
        processCache = { data: list, timestamp: now };
        return list;
    } catch (err) {
        return [];
    }
}

// Lokasi file antarmuka frontend (public/index.html)
const INDEX_HTML_PATH = path.join(__dirname, 'public', 'index.html');

/**
 * Validasi keamanan path agar tetap berada di dalam /home
 */
function resolveSafePath(targetPath = '') {
    const cleaned = String(targetPath || '').replace(/^\/+/, '');
    const resolved = path.resolve(PROJECTS_ROOT, cleaned);
    if (resolved !== PROJECTS_ROOT && !resolved.startsWith(PROJECTS_ROOT + path.sep)) {
        throw new Error('Akses path di luar /home tidak diizinkan.');
    }
    return resolved;
}

/**
 * Helper membaca body JSON dari request POST
 */
function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
            if (body.length > 5 * 1024 * 1024) {
                reject(new Error('Ukuran payload terlalu besar (maks 5MB).'));
                req.destroy();
            }
        });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (err) {
                reject(new Error('Format JSON tidak valid.'));
            }
        });
        req.on('error', reject);
    });
}

/**
 * Inisialisasi HTTP Server Bawaan Node.js
 */
const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // Endpoint ringan untuk cek kesehatan server (Healthcheck)
    if (reqUrl.pathname === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', uptime: os.uptime() }));
        return;
    }

    // Endpoint API JSON untuk telemetri real-time
    if (reqUrl.pathname === '/api/stats') {
        try {
            const voltParam = parseInt(reqUrl.searchParams.get('volt'), 10) === 12 ? 12 : 5;
            const cpu = getCpuMetrics();
            const memory = getMemoryMetrics();
            const storage = getStorageMetrics();
            const temperature = getTemperatureMetrics();
            const power = getPowerMetrics(cpu.usage, voltParam);
            const system = getSystemInfo();
            const processes = getTopProcesses();

            const payload = JSON.stringify({
                cpu,
                memory,
                storage,
                temperature,
                power,
                system,
                processes
            });

            res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store'
            });
            res.end(payload);
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Gagal membaca telemetri sistem' }));
        }
        return;
    }

    // =========================================================================
    // API FILE MANAGER (/home/<nama-projek>)
    // =========================================================================

    // 1. Daftar File & Folder
    if (reqUrl.pathname === '/api/files/list' && req.method === 'GET') {
        try {
            const relPath = reqUrl.searchParams.get('path') || '';
            const targetDir = resolveSafePath(relPath);

            if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Direktori tidak ditemukan.' }));
                return;
            }

            const entries = fs.readdirSync(targetDir, { withFileTypes: true });
            const items = [];

            for (const entry of entries) {
                // Sembunyikan folder konfigurasi sistem di root /home
                if (relPath === '' && entry.name.startsWith('.')) continue;

                const fullItemPath = path.join(targetDir, entry.name);
                let size = 0;
                let mtime = new Date().toISOString();
                let isDirectory = entry.isDirectory();

                try {
                    const stats = fs.statSync(fullItemPath);
                    isDirectory = stats.isDirectory();
                    size = isDirectory ? 0 : stats.size;
                    mtime = stats.mtime.toISOString();
                } catch (e) {
                    // Abaikan file yang tidak bisa di-stat
                }

                const itemRelPath = relPath ? `${relPath}/${entry.name}` : entry.name;
                items.push({
                    name: entry.name,
                    relPath: itemRelPath,
                    isDirectory,
                    size,
                    mtime,
                    isZip: !isDirectory && entry.name.toLowerCase().endsWith('.zip')
                });
            }

            // Urutkan folder di atas, lalu berdasarkan abjad
            items.sort((a, b) => {
                if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
                return a.name.localeCompare(b.name);
            });

            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
                root: PROJECTS_ROOT,
                currentPath: relPath,
                items
            }));
        } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // 2. Buat Projek Baru / Folder Baru
    if (reqUrl.pathname === '/api/files/mkdir' && req.method === 'POST') {
        try {
            const { path: relPath = '', name = '' } = await readJsonBody(req);
            const cleanName = String(name).trim();
            if (!cleanName || cleanName.includes('/') || cleanName.includes('\\') || cleanName === '..' || cleanName === '.') {
                throw new Error('Nama projek/folder tidak valid.');
            }
            const parentDir = resolveSafePath(relPath);
            const newDir = path.join(parentDir, cleanName);
            if (fs.existsSync(newDir)) {
                throw new Error('Folder atau projek dengan nama tersebut sudah ada.');
            }
            fs.mkdirSync(newDir, { recursive: true });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, path: relPath ? `${relPath}/${cleanName}` : cleanName }));
        } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // 3. Upload File / ZIP (Streaming langsung ke disk agar hemat RAM 2GB)
    if (reqUrl.pathname === '/api/files/upload' && req.method === 'POST') {
        try {
            const relDir = reqUrl.searchParams.get('path') || '';
            const rawName = reqUrl.searchParams.get('name') || 'upload.bin';
            const fileName = path.basename(rawName);
            const targetDir = resolveSafePath(relDir);

            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }

            const destFile = path.join(targetDir, fileName);
            const writeStream = fs.createWriteStream(destFile);

            req.pipe(writeStream);

            req.on('error', (err) => {
                writeStream.destroy();
                if (!res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Koneksi upload terputus: ' + err.message }));
                }
            });

            writeStream.on('finish', () => {
                if (!res.headersSent) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, fileName }));
                }
            });

            writeStream.on('error', (err) => {
                if (!res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Gagal menyimpan file upload: ' + err.message }));
                }
            });
        } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // 4. Ekstrak File ZIP (Unzip)
    if (reqUrl.pathname === '/api/files/unzip' && req.method === 'POST') {
        try {
            const { path: zipRelPath } = await readJsonBody(req);
            const zipFullPath = resolveSafePath(zipRelPath);
            if (!fs.existsSync(zipFullPath)) {
                throw new Error('File ZIP tidak ditemukan.');
            }
            const destDir = path.dirname(zipFullPath);

            try {
                execSync(`unzip -o "${zipFullPath}" -d "${destDir}"`, { stdio: 'pipe', timeout: 30000 });
            } catch (unzipErr) {
                // Fallback jika paket 'unzip' belum terinstal di Armbian: gunakan Python3 bawaan
                execSync(`python3 -m zipfile -e "${zipFullPath}" "${destDir}"`, { stdio: 'pipe', timeout: 30000 });
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Gagal unzip file: ' + err.message }));
        }
        return;
    }

    // 5. Baca Isi File untuk Editor Kode
    if (reqUrl.pathname === '/api/files/read' && req.method === 'GET') {
        try {
            const relPath = reqUrl.searchParams.get('path') || '';
            const fullPath = resolveSafePath(relPath);
            const stats = fs.statSync(fullPath);

            if (stats.isDirectory()) {
                throw new Error('Tidak dapat mengedit direktori.');
            }
            if (stats.size > 2 * 1024 * 1024) {
                throw new Error('Ukuran file terlalu besar untuk diedit di browser (> 2MB).');
            }

            const content = fs.readFileSync(fullPath, 'utf8');
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
                name: path.basename(fullPath),
                relPath,
                content
            }));
        } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // 6. Simpan File Baru / Hasil Edit
    if (reqUrl.pathname === '/api/files/save' && req.method === 'POST') {
        try {
            const { path: relPath, content = '' } = await readJsonBody(req);
            const fullPath = resolveSafePath(relPath);
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, content, 'utf8');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // 7. Download File
    if (reqUrl.pathname === '/api/files/download' && req.method === 'GET') {
        try {
            const relPath = reqUrl.searchParams.get('path') || '';
            const fullPath = resolveSafePath(relPath);
            const stats = fs.statSync(fullPath);

            if (stats.isDirectory()) {
                throw new Error('Gunakan file ZIP untuk mengunduh folder.');
            }

            const fileName = path.basename(fullPath);
            res.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
                'Content-Length': stats.size
            });
            fs.createReadStream(fullPath).pipe(res);
        } catch (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Gagal download file: ' + err.message);
        }
        return;
    }

    // 8. Hapus File atau Folder Projek
    if (reqUrl.pathname === '/api/files/delete' && req.method === 'POST') {
        try {
            const { path: relPath } = await readJsonBody(req);
            const fullPath = resolveSafePath(relPath);
            if (fullPath === PROJECTS_ROOT) {
                throw new Error('Direktori utama /home tidak boleh dihapus.');
            }
            fs.rmSync(fullPath, { recursive: true, force: true });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // =========================================================================
    // API WEB TERMINAL (Streaming Output Real-Time via SSE)
    // =========================================================================

    // Jalankan perintah shell di direktori projek
    if (reqUrl.pathname === '/api/terminal/stream' && req.method === 'GET') {
        const cmd = (reqUrl.searchParams.get('cmd') || '').trim();
        const cwdRel = reqUrl.searchParams.get('cwd') || '';
        const sessionId = reqUrl.searchParams.get('id') || String(Date.now());

        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });

        const sendEvent = (event, data) => {
            if (!res.writableEnded) {
                res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            }
        };

        try {
            const currentCwd = resolveSafePath(cwdRel);

            // Tangani perintah pindah direktori (cd) agar state path ikut berubah
            if (cmd === 'cd' || cmd.startsWith('cd ')) {
                const targetArg = cmd === 'cd' ? '' : cmd.slice(3).trim();
                const nextFull = targetArg === '' || targetArg === '~'
                    ? PROJECTS_ROOT
                    : path.resolve(currentCwd, targetArg);

                if (nextFull !== PROJECTS_ROOT && !nextFull.startsWith(PROJECTS_ROOT + path.sep)) {
                    sendEvent('stderr', 'Akses cd dibatasi hanya di dalam area /home.\n');
                } else if (!fs.existsSync(nextFull) || !fs.statSync(nextFull).isDirectory()) {
                    sendEvent('stderr', `bash: cd: ${targetArg}: Direktori tidak ditemukan\n`);
                } else {
                    const nextRel = path.relative(PROJECTS_ROOT, nextFull).replace(/\\/g, '/');
                    sendEvent('cwd', { cwd: nextRel, fullPath: nextFull });
                }
                sendEvent('done', { code: 0 });
                res.end();
                return;
            }

            const shellBin = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
            const child = spawn(shellBin, ['-c', cmd], {
                cwd: currentCwd,
                env: {
                    ...process.env,
                    TERM: 'dumb',
                    NO_COLOR: '1',
                    FORCE_COLOR: '0'
                }
            });

            activeTerminals.set(sessionId, child);

            // Hapus kode warna ANSI agar teks bersih di terminal web
            const stripAnsi = (str) => String(str).replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');

            child.stdout.on('data', (chunk) => {
                sendEvent('stdout', stripAnsi(chunk.toString('utf8')));
            });

            child.stderr.on('data', (chunk) => {
                sendEvent('stderr', stripAnsi(chunk.toString('utf8')));
            });

            child.on('error', (err) => {
                sendEvent('stderr', `Error menjalankan perintah: ${err.message}\n`);
            });

            child.on('close', (code) => {
                activeTerminals.delete(sessionId);
                sendEvent('done', { code: code ?? 0 });
                if (!res.writableEnded) res.end();
            });

            req.on('close', () => {
                if (activeTerminals.has(sessionId)) {
                    try { child.kill('SIGTERM'); } catch (e) {}
                    activeTerminals.delete(sessionId);
                }
            });
        } catch (err) {
            sendEvent('stderr', `${err.message}\n`);
            sendEvent('done', { code: 1 });
            if (!res.writableEnded) res.end();
        }
        return;
    }

    // Hentikan perintah terminal yang sedang berjalan (Ctrl+C)
    if (reqUrl.pathname === '/api/terminal/kill' && req.method === 'POST') {
        try {
            const { id } = await readJsonBody(req);
            const child = activeTerminals.get(String(id));
            if (child) {
                child.kill('SIGINT');
                setTimeout(() => {
                    try { child.kill('SIGKILL'); } catch (e) {}
                }, 800);
                activeTerminals.delete(String(id));
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // Endpoint Utama: Membaca & menyajikan file static public/index.html
    if (reqUrl.pathname === '/' || reqUrl.pathname === '/index.html') {
        fs.readFile(INDEX_HTML_PATH, 'utf8', (err, htmlContent) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('500 Internal Server Error: File public/index.html tidak ditemukan.');
                return;
            }
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-cache'
            });
            res.end(htmlContent);
        });
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
});

// Penanganan error port (misal saat restart cepat setelah listrik menyala kembali)
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`[Server] Port ${PORT} masih dipakai, mencoba ulang dalam 2 detik...`);
        setTimeout(() => {
            server.close();
            server.listen(PORT, '0.0.0.0');
        }, 2000);
    } else {
        console.error('[Server] Error jaringan:', err.message);
    }
});

// Listen pada 0.0.0.0 agar tetap berhasil start saat boot awal meski WiFi belum tersambung
server.listen(PORT, '0.0.0.0', () => {
    console.log('====================================================');
    console.log(` Home Server - Dalang Store berjalan di port ${PORT}`);
    console.log(` Buka di browser: http://<IP-STB-ARMBIAN>:${PORT}`);
    console.log('====================================================');
});
