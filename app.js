// URL Backend (gunakan relative path agar fleksibel di root maupun subfolder seperti /ykk/)
const API_BASE_URL = 'api.php';

const getTanggalLike = (periode) => {
    let year = parseInt(periode.substring(0, 4));
    let month = parseInt(periode.substring(4, 6));
    month += 1;
    if (month > 12) {
        month = 1;
        year += 1;
    }
    const mm = month.toString().padStart(2, '0');
    return `${year}-${mm}`;
};

const getQueries = (periode, tanggalTagrek) => {
    const tanggal = getTanggalLike(periode);
    const filterTgl = tanggalTagrek || (typeof datePicker !== 'undefined' && datePicker ? datePicker.value : '');
    const tmpSetup = `-- [1. Buat Tabel Eliminasi In-Memory (Hash Index)]
CREATE TEMPORARY TABLE IF NOT EXISTS tmp_eliminasi (
    no_pdam VARCHAR(10) CHARACTER SET utf8 COLLATE utf8_general_ci PRIMARY KEY,
    alasan VARCHAR(20)
) ENGINE=MEMORY;
TRUNCATE TABLE tmp_eliminasi;

-- [2. Kumpulkan Pelanggan Tereliminasi ke Memori]
-- A. Data Tunggakan Reguler / Non-YKK (IS_YKK = 0): Semua Belum Lunas Dieliminasi
INSERT IGNORE INTO tmp_eliminasi (no_pdam, alasan)
SELECT no_pdam, 'Tunggakan' 
FROM spd_tunggak c USE INDEX(LUNAS)
WHERE c.IS_DELETE = 0 AND c.IS_YKK = 0 AND c.LUNAS = 0 AND (c.PH IS NULL OR c.PH != 'P');

-- B. Data Tunggakan YKK (IS_YKK = 1): Maksimal 3 Bulan Lolos, > 3 Bulan Dieliminasi
INSERT IGNORE INTO tmp_eliminasi (no_pdam, alasan)
SELECT no_pdam, 'Tunggakan YKK >3 Bln' 
FROM spd_tunggak c USE INDEX(LUNAS)
WHERE c.IS_DELETE = 0 AND c.IS_YKK = 1 AND c.LUNAS = 0
GROUP BY no_pdam
HAVING COUNT(*) > 3;

-- C. Data Tunggakan YKK Status Penghapusan (PH = 'P')
INSERT IGNORE INTO tmp_eliminasi (no_pdam, alasan)
SELECT no_pdam, 'Tunggakan PH' 
FROM spd_tunggak c USE INDEX(IS_YKK)
WHERE c.IS_DELETE = 0 AND c.IS_YKK = 1 AND c.PH = 'P';

-- B. Data Penertiban
INSERT IGNORE INTO tmp_eliminasi (no_pdam, alasan)
SELECT no_pdam, 'Penertiban' FROM spd_bon d 
WHERE d.TANGGAL LIKE '${tanggal}-%' AND d.IS_DELETE = '0' AND d.STPLYN_ID LIKE 't%' AND d.LUNAS = '0';

-- C. Data Realisasi
INSERT IGNORE INTO tmp_eliminasi (no_pdam, alasan)
SELECT no_pdam, 'Realisasi' FROM spd_realmohon e 
WHERE e.TANGGAL LIKE '${tanggal}%' AND e.STPLYN_ID LIKE 't%';

-- D. Data Subsidi Periode Terpilih
INSERT IGNORE INTO tmp_eliminasi (no_pdam, alasan)
SELECT no_pdam, 'Subsidi' FROM spd_rekening f 
WHERE f.PERIODE = '${periode}' AND f.subsidi != 0 AND f.FLAG = '0';
`;

    return {
        beli: `${tmpSetup}
-- [3. Kueri Utama Rencana Beli YKK]
SELECT 
    a.NO_PDAM, 
    b.NAMA, 
    a.PERIODE, 
    a.LOKBAY_ID, 
    a.STGOL_ID, 
    a.RK, 
    a.NON_AIR
FROM spd_rekening a 
JOIN spd_stlgn b ON b.ID = a.STLGN_ID
LEFT JOIN tmp_eliminasi x ON x.no_pdam = a.no_pdam
WHERE 
    a.PERIODE = '${periode}' 
    AND a.STATUS = 'a' 
    AND a.FLAG = '0' 
    AND a.IS_TUTUPMETER = 1 
    AND a.LOKBAY_ID IN ('KB', 'KM', 'KS', 'L') 
    AND a.STGOL_ID IN ('IIA1','IIA2','IIA3','IIIA','IIIB','IVA','IVB')
    AND b.nama NOT LIKE '%rumdis%' 
    AND b.nama NOT LIKE '%rumdin%' 
    AND b.nama NOT LIKE '%rusus%'
    AND x.no_pdam IS NULL;`,
        batal: `${tmpSetup}
-- [3. Kueri Utama Rencana Pembatalan YKK]
SELECT 
    a.NO_PDAM, 
    b.NAMA, 
    a.PERIODE, 
    a.LOKBAY_ID, 
    a.STGOL_ID, 
    a.RK, 
    a.NON_AIR,
    CASE
        WHEN a.STGOL_ID IN ('IB', 'IIB1', 'IIB3', 'IA', 'IIB2', 'IB3', 'IB2', 'IB1', 'IIB4') THEN CONCAT('Golongan ', a.STGOL_ID)
        WHEN a.STATUS != 'a' THEN CONCAT('Status ', UPPER(a.STATUS))
        WHEN a.IS_TUTUPMETER != 1 THEN 'Bukan Tutup Meter'
        WHEN LOWER(b.NAMA) LIKE '%rumdis%' THEN 'Rumdis'
        WHEN LOWER(b.NAMA) LIKE '%rumdin%' THEN 'Rumdin'
        WHEN LOWER(b.NAMA) LIKE '%rusus%' THEN 'Rusus'
        WHEN x.alasan IS NOT NULL THEN x.alasan
        ELSE 'Lainnya'
    END AS ALASAN
FROM spd_rekening a 
JOIN spd_stlgn b ON b.ID = a.STLGN_ID
LEFT JOIN tmp_eliminasi x ON x.no_pdam = a.no_pdam
WHERE 
    a.PERIODE = '${periode}' 
    AND a.STATUS != 'l' 
    AND a.FLAG = '0' 
    AND a.LOKBAY_ID IN ('KB', 'KM', 'KS', 'L') 
    AND (
        a.STGOL_ID IN ('IB', 'IIB1', 'IIB3', 'IA', 'IIB2', 'IB3', 'IB2', 'IB1', 'IIB4')
        OR (
            a.STGOL_ID IN ('IIA1','IIA2','IIA3','IIIA','IIIB','IVA','IVB')
            AND (
                a.STATUS != 'a'
                OR a.IS_TUTUPMETER != 1
                OR (b.nama LIKE '%rumdis%' OR b.nama LIKE '%rumdin%' OR b.nama LIKE '%rusus%')
                OR x.no_pdam IS NOT NULL
            )
        )
    );`,
        dibeli: `-- [Kueri Rekening yang Sudah Resmi Dibeli YKK Berdasarkan Tanggal Transaksi Kasir]
SELECT 
    a.NO_PDAM, 
    b.NAMA, 
    a.REKENING_BULAN AS PERIODE, 
    a.TANGGAL AS TGL_BAYAR,
    a.LOKBAY_ID, 
    a.STGOL_ID, 
    a.HARGA AS RK, 
    a.NON_AIR,
    COALESCE(a.MATERAI, 0) AS MATERAI,
    (a.HARGA + a.NON_AIR + COALESCE(a.MATERAI, 0)) AS TAGIHAN,
    COALESCE(t.DENDA, 0) AS DENDA_YKK,
    (a.HARGA + a.NON_AIR + COALESCE(a.MATERAI, 0) + COALESCE(t.DENDA, 0)) AS TOTAL_BAYAR
FROM spd_tagrek a 
JOIN spd_stlgn b ON b.ID = a.STLGN_ID
LEFT JOIN spd_tunggak t ON t.NO_PDAM = a.NO_PDAM 
    AND t.IS_YKK = 1 
    AND t.IS_DELETE = '0'
    AND t.REKENING_BULAN = CONCAT(LEFT(a.REKENING_BULAN, 4), '-', SUBSTRING(a.REKENING_BULAN, 5, 2), '-20')
WHERE 
    a.TANGGAL = '${filterTgl}'
    AND a.IS_YKK = 1 
    AND a.IS_DELETE = '0'
ORDER BY a.NO_PDAM ASC;`
    };
};

// DOM Elements
const navItems = document.querySelectorAll('.nav-item');
const pageTitle = document.getElementById('page-title');
const tableBody = document.getElementById('table-body');
const thAlasan = document.getElementById('th-alasan');
const thTglBayar = document.getElementById('th-tgl-bayar');
const thDenda = document.getElementById('th-denda');
const thJumlah = document.getElementById('th-jumlah');
const sqlCode = document.getElementById('sql-code');
const btnToggleQuery = document.getElementById('btn-toggle-query');
const queryContent = document.getElementById('query-content');
const statTotal = document.getElementById('stat-total');
const statTotalJumlah = document.getElementById('stat-total-jumlah');
const statTunggakan = document.getElementById('stat-tunggakan');
const statCardAlasan = document.getElementById('stat-card-alasan');
const statCardSisa = document.getElementById('stat-card-sisa');
const statSisaBudget = document.getElementById('stat-sisa-budget');
const statSisaSub = document.getElementById('stat-sisa-sub');
const statTotalSub = document.getElementById('stat-total-sub');
const statTotalJumlahSub = document.getElementById('stat-total-jumlah-sub');
const pageCount = document.getElementById('page-count');
const btnRefresh = document.querySelector('header .icon-btn[title="Refresh Data"]');
const btnLoadData = document.getElementById('btn-load-data');
const searchInput = document.getElementById('search-input');
const btnExport = document.getElementById('btn-export');
const datePicker = document.getElementById('date-picker');
const periodeLabel = document.getElementById('periode-label');
const thKuota = document.getElementById('th-kuota');

// Budget Elements
const budgetPanel = document.getElementById('budget-panel');
const budgetInput = document.getElementById('budget-input');
const btnClearBudget = document.getElementById('btn-clear-budget');
const budgetPresetChips = document.querySelectorAll('.preset-chip');
const budgetProgressSection = document.getElementById('budget-progress-section');
const budgetProgressBarFill = document.getElementById('budget-progress-bar-fill');
const budgetPercentText = document.getElementById('budget-percent-text');
const budgetSummaryText = document.getElementById('budget-summary-text');
const toggleOnlyKuota = document.getElementById('toggle-only-kuota');

// Automation Elements
const otomasiSection = document.getElementById('otomasi-section');
const mainTablePanel = document.querySelector('.main-table-panel') || document.querySelector('.table-container');
const statsGrid = document.querySelector('.stats-grid');
const queryContainerPanel = document.getElementById('query-container-panel');
const formYkkConfig = document.getElementById('form-ykk-config');
const cfgPeriode = document.getElementById('cfg-periode');
const cfgJadwal = document.getElementById('cfg-jadwal');
const cfgBudget = document.getElementById('cfg-budget');
const btnPreset2Min = document.getElementById('btn-preset-2min');
const btnPreset21st = document.getElementById('btn-preset-21st');
const countdownTimer = document.getElementById('countdown-timer');
const countdownDetail = document.getElementById('countdown-detail');
const autoScheduleBadge = document.getElementById('auto-schedule-badge');
const btnRunSimulasi = document.getElementById('btn-run-simulasi');
const btnManualExecute = document.getElementById('btn-manual-execute');
const btnRefreshHistory = document.getElementById('btn-refresh-history');
const btnRefreshConfigs = document.getElementById('btn-refresh-configs');
const historyTableBody = document.getElementById('history-table-body');
const simStatusBadge = document.getElementById('sim-status-badge');
const simTotalRek = document.getElementById('sim-total-rek');
const simTotalTagihan = document.getElementById('sim-total-tagihan');
const simTotalDenda = document.getElementById('sim-total-denda');
const simTotalBayar = document.getElementById('sim-total-bayar');
const simSisaBudget = document.getElementById('sim-sisa-budget');

// Backup Elements
const backupSection = document.getElementById('backup-section');
const statBackupFiles = document.getElementById('stat-backup-files');
const statBackupSize = document.getElementById('stat-backup-size');
const statBackupLast = document.getElementById('stat-backup-last');
const statBackupLastSub = document.getElementById('stat-backup-last-sub');
const backupTableBody = document.getElementById('backup-table-body');
const backupLogConsole = document.getElementById('backup-log-console');
const btnRunBackupNow = document.getElementById('btn-run-backup-now');
const btnRefreshBackups = document.getElementById('btn-refresh-backups');
const backupCountdownTimer = document.getElementById('backup-countdown-timer');
const backupCountdownDetail = document.getElementById('backup-countdown-detail');
let backupCountdownInterval = null;

let maxBudget = 0; // 0 = Tanpa batas (Semua)

const namaBulan = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];

// Menghitung periode dari tanggal yang dipilih pada date picker
// Rumus: nama bulan = periode + 1 bulan
// Contoh: 20 Agustus 2026 -> bulan Agustus (08) -> periode Juli 2026 (202607)
function getPeriodeFromDate(dateStr) {
    if (!dateStr) {
        const d = new Date();
        dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    const parts = dateStr.split('-');
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10); // 1-12
    
    let pMonth = month - 1;
    let pYear = year;
    if (pMonth === 0) {
        pMonth = 12;
        pYear--;
    }
    return `${pYear}${pMonth.toString().padStart(2, '0')}`;
}

function getSelectedPeriode() {
    return getPeriodeFromDate(datePicker.value);
}

function updatePeriodeUI() {
    const periode = getSelectedPeriode();
    const dateVal = datePicker.value || '';
    const parts = dateVal.split('-');
    
    if (currentTab === 'dibeli') {
        periodeLabel.innerHTML = `Tgl Bayar: <strong id="periode-code">${dateVal}</strong>`;
    } else {
        if (parts.length === 3) {
            const year = parseInt(parts[0], 10);
            const month = parseInt(parts[1], 10);
            const monthName = namaBulan[month - 1] || '';
            periodeLabel.innerHTML = `Periode: <strong id="periode-code">${periode}</strong> <span style="opacity: 0.8; font-size: 0.75rem; margin-left: 2px;">(${monthName} ${year})</span>`;
        } else {
            periodeLabel.innerHTML = `Periode: <strong id="periode-code">${periode}</strong>`;
        }
    }
    
    // Update SQL Code
    if (sqlCode) {
        sqlCode.textContent = getQueries(periode, dateVal)[currentTab];
    }
}

let currentTab = 'beli';
let currentData = []; // Store the data globally for search and export

// Inisialisasi default date picker ke tanggal hari ini
const today = new Date();
const yyyy = today.getFullYear();
const mm = String(today.getMonth() + 1).padStart(2, '0');
const dd = String(today.getDate()).padStart(2, '0');
datePicker.value = `${yyyy}-${mm}-${dd}`;

updatePeriodeUI();

// Helper to render badge based on ALASAN
function getAlasanBadge(alasan) {
    if (!alasan) return '';
    let badgeClass = 'badge-info';
    
    if (alasan.startsWith('Tunggakan') || alasan === 'Penertiban') {
        badgeClass = 'badge-danger';
    } else if (alasan === 'Rumdis' || alasan === 'Rumdin' || alasan === 'Rusus' || alasan === 'Bukan Tutup Meter') {
        badgeClass = 'badge-warning';
    } else if (alasan === 'Subsidi' || alasan === 'Realisasi') {
        badgeClass = 'badge-success';
    } else if (alasan.startsWith('Golongan')) {
        badgeClass = 'badge-purple';
    }
    
    return `<span class="badge ${badgeClass}">${alasan}</span>`;
}

// Helper to format currency
const formatRupiah = (angka) => {
    return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(angka);
};

// Hitung alokasi kuota anggaran (Opsi 1: Urutkan tagihan terkecil ke terbesar ASC)
function applyBudgetAllocation() {
    if (currentTab !== 'beli' || currentData.length === 0) {
        return;
    }

    // Pastikan setiap data memiliki nominal _jumlah yang valid
    currentData.forEach(row => {
        const rk = parseFloat(row.RK) || 0;
        const nonAir = parseFloat(row.NON_AIR) || 0;
        row._jumlah = rk + nonAir;
    });

    // Opsi 1: Sort ASC berdasarkan tagihan terkecil
    currentData.sort((a, b) => a._jumlah - b._jumlah);

    let runningCumSum = 0;
    let inQuotaCount = 0;
    let inQuotaAmount = 0;

    currentData.forEach(row => {
        if (maxBudget > 0) {
            if (runningCumSum + row._jumlah <= maxBudget) {
                runningCumSum += row._jumlah;
                row.masuk_kuota = true;
                row._cum_sum = runningCumSum;
                inQuotaCount++;
                inQuotaAmount += row._jumlah;
            } else {
                row.masuk_kuota = false;
                row._cum_sum = runningCumSum + row._jumlah;
            }
        } else {
            row.masuk_kuota = true;
            runningCumSum += row._jumlah;
            row._cum_sum = runningCumSum;
            inQuotaCount++;
            inQuotaAmount += row._jumlah;
        }
    });

    // Update UI Progress Bar & Summary
    if (maxBudget > 0) {
        budgetProgressSection.style.display = 'flex';
        btnClearBudget.style.display = 'flex';
        statCardSisa.style.display = 'flex';

        const percent = Math.min(100, (inQuotaAmount / maxBudget) * 100);
        budgetPercentText.textContent = `${percent.toFixed(1)}%`;
        budgetSummaryText.textContent = `(${formatRupiah(inQuotaAmount)} / ${formatRupiah(maxBudget)})`;
        budgetProgressBarFill.style.width = `${percent}%`;

        if (percent >= 98) {
            budgetProgressBarFill.classList.add('warning');
        } else {
            budgetProgressBarFill.classList.remove('warning');
        }

        const sisa = Math.max(0, maxBudget - inQuotaAmount);
        statSisaBudget.textContent = formatRupiah(sisa);
        statSisaSub.textContent = `${percent.toFixed(1)}% anggaran terserap`;
    } else {
        budgetProgressSection.style.display = 'none';
        btnClearBudget.style.display = 'none';
        statCardSisa.style.display = 'none';
    }
}

// Dapatkan data yang sudah terfilter (Search text + Filter Kuota)
function getFilteredData() {
    const query = (searchInput.value || '').toLowerCase().trim();
    return currentData.filter(row => {
        const matchesSearch = !query || 
            (row.NO_PDAM || '').toString().toLowerCase().includes(query) || 
            (row.NAMA || '').toString().toLowerCase().includes(query);

        if (!matchesSearch) return false;

        // Jika tab beli dan ada pembatasan budget serta toggle aktif
        if (currentTab === 'beli' && maxBudget > 0 && toggleOnlyKuota && toggleOnlyKuota.checked) {
            return row.masuk_kuota === true;
        }

        return true;
    });
}

// Fetch Data from API
async function fetchData(type) {
    const progressBar = document.getElementById('table-progress-bar');
    if (progressBar) progressBar.style.display = 'block';

    // Show Loading Animation in Table
    tableBody.innerHTML = `
        <tr>
            <td colspan="11">
                <div class="loading-container">
                    <div class="loading-spinner-wrapper">
                        <div class="loading-ring"></div>
                        <div class="loading-ring-inner"></div>
                        <i class="ph ph-database"></i>
                    </div>
                    <div class="loading-title">Sedang Mengambil Data dari Database...</div>
                    <div class="loading-subtitle">Menyaring jutaan data rekening, pengecekan tunggakan, penertiban & realisasi untuk periode terpilih.</div>
                    <div class="loading-skeleton-bar"></div>
                </div>
            </td>
        </tr>
    `;
    
    // Disable Buttons & Update text with spinning icon
    btnLoadData.disabled = true;
    btnLoadData.classList.add('btn-loading');
    btnLoadData.innerHTML = '<i class="ph ph-spinner spinner"></i> Memuat Data...';
    if (btnRefresh) {
        btnRefresh.disabled = true;
        btnRefresh.innerHTML = '<i class="ph ph-spinner spinner"></i>';
    }
    
    const periode = getSelectedPeriode();
    const tanggal = datePicker.value || '';
    
    try {
        let url = `${API_BASE_URL}?action=${type}&periode=${periode}`;
        if (type === 'dibeli') {
            url = `${API_BASE_URL}?action=dibeli&tanggal=${tanggal}&periode=${periode}`;
        }
        const response = await fetch(url);
        const text = await response.text();
        let data;
        try {
            data = JSON.parse(text);
        } catch (parseErr) {
            const cleanErr = text.replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim();
            throw new Error(cleanErr || 'Server mengembalikan respon tidak valid.');
        }
        if (!response.ok || (data && data.error)) {
            throw new Error((data && data.error) ? data.error : `HTTP ${response.status} ${response.statusText}`);
        }
        currentData = data;
        searchInput.value = ''; // Reset search field

        if (type === 'beli') {
            applyBudgetAllocation();
        }

        const filtered = getFilteredData();
        renderTable(filtered, type);
    } catch (error) {
        console.error('Error fetching data:', error);
        tableBody.innerHTML = `<tr><td colspan="11" style="text-align: center; padding: 2.5rem; color: #ef4444;"><i class="ph ph-warning-circle" style="font-size: 1.5rem; display: block; margin-bottom: 0.5rem;"></i>Gagal mengambil data dari server.<br><small style="color: #94a3b8; font-size: 0.85rem; margin-top: 0.25rem; display: inline-block;">${error.message || 'Pastikan backend dan koneksi database berjalan.'}</small></td></tr>`;
        
        // Reset stats
        statTotal.textContent = '0';
        statTotalJumlah.textContent = 'Rp 0';
        statTotalSub.style.display = 'none';
        statTotalJumlahSub.style.display = 'none';
        pageCount.textContent = '0';
        statTunggakan.textContent = '0';
        statCardSisa.style.display = 'none';
    } finally {
        if (progressBar) progressBar.style.display = 'none';
        btnLoadData.disabled = false;
        btnLoadData.classList.remove('btn-loading');
        btnLoadData.innerHTML = '<i class="ph ph-database"></i> Tampilkan Data';
        if (btnRefresh) {
            btnRefresh.disabled = false;
            btnRefresh.innerHTML = '<i class="ph ph-arrows-clockwise"></i>';
        }
    }
}

// Render Table Data
function renderTable(data, type) {
    tableBody.innerHTML = '';
    let grandTotal = 0;
    
    // Tampilkan / sembunyikan kolom header dinamis
    if (thKuota) {
        thKuota.style.display = (type === 'beli' && maxBudget > 0) ? 'table-cell' : 'none';
    }
    if (thAlasan) {
        thAlasan.style.display = (type === 'batal') ? 'table-cell' : 'none';
    }
    if (thTglBayar) {
        thTglBayar.style.display = (type === 'dibeli') ? 'table-cell' : 'none';
    }
    if (thDenda) {
        thDenda.style.display = (type === 'dibeli') ? 'table-cell' : 'none';
    }

    if (data.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="12" style="text-align: center; padding: 2.5rem; color: var(--text-secondary);">Tidak ada data yang sesuai filter.</td></tr>`;
    } else {
        data.forEach(row => {
            const tr = document.createElement('tr');
            
            const rk = parseFloat(row.RK) || 0;
            const nonAir = parseFloat(row.NON_AIR) || 0;
            const materai = parseFloat(row.MATERAI) || 0;
            const tagihanPokok = (rk + nonAir + materai);
            const jumlah = row._jumlah !== undefined ? row._jumlah : tagihanPokok;
            grandTotal += jumlah;
            
            if (type === 'beli' && maxBudget > 0 && !row.masuk_kuota) {
                tr.classList.add('row-outside-kuota');
            }

            let html = `
                <td><strong>${row.NO_PDAM}</strong></td>
                <td>${row.NAMA}</td>
                <td>${row.PERIODE}</td>
            `;

            if (type === 'dibeli') {
                html += `<td><span class="badge badge-purple">${row.TGL_BAYAR || '-'}</span></td>`;
            }

            html += `
                <td><span class="badge badge-info">${row.LOKBAY_ID}</span></td>
                <td>${row.STGOL_ID}</td>
            `;
            
            if (type === 'batal') {
                html += `<td>${getAlasanBadge(row.ALASAN)}</td>`;
            }

            if (type === 'beli' && maxBudget > 0) {
                if (row.masuk_kuota) {
                    html += `<td><span class="badge badge-success"><i class="ph ph-check-circle"></i> Masuk Kuota</span></td>`;
                } else {
                    html += `<td><span class="badge badge-secondary"><i class="ph ph-prohibit"></i> Melebihi Plafon</span></td>`;
                }
            }
            
            html += `
                <td style="text-align: right;">${formatRupiah(rk)}</td>
                <td style="text-align: right;">${formatRupiah(nonAir)}</td>
            `;

            if (type === 'dibeli') {
                const dendaYkk = parseFloat(row.DENDA_YKK) || 0;
                const totalBayar = parseFloat(row.TOTAL_BAYAR) || (jumlah + dendaYkk);
                html += `
                    <td style="text-align: right;" class="text-warning">${formatRupiah(dendaYkk)}</td>
                    <td style="text-align: right;" class="text-accent"><strong>${formatRupiah(totalBayar)}</strong></td>
                `;
            } else {
                html += `
                    <td style="text-align: right;" class="text-accent"><strong>${formatRupiah(jumlah)}</strong></td>
                `;
            }
            
            html += `
                <td>
                    <button class="icon-btn" title="Detail"><i class="ph ph-eye"></i></button>
                </td>
            `;
            
            tr.innerHTML = html;
            tableBody.appendChild(tr);
        });
    }
    
    // Update Stats
    pageCount.textContent = data.length.toLocaleString('id-ID');

    if (type === 'beli') {
        if (maxBudget > 0) {
            const inQuotaList = currentData.filter(r => r.masuk_kuota);
            const inQuotaCount = inQuotaList.length;
            const inQuotaAmount = inQuotaList.reduce((sum, r) => sum + r._jumlah, 0);

            statTotal.textContent = inQuotaCount.toLocaleString('id-ID');
            statTotalSub.style.display = 'block';
            statTotalSub.textContent = `Dari total ${currentData.length.toLocaleString('id-ID')} pelanggan`;

            statTotalJumlah.textContent = formatRupiah(inQuotaAmount);
            statTotalJumlahSub.style.display = 'block';
            statTotalJumlahSub.textContent = `Plafon: ${formatRupiah(maxBudget)}`;
        } else {
            statTotal.textContent = currentData.length.toLocaleString('id-ID');
            statTotalSub.style.display = 'none';
            statTotalJumlah.textContent = formatRupiah(grandTotal);
            statTotalJumlahSub.style.display = 'none';
            statCardSisa.style.display = 'none';
        }
    } else if (type === 'dibeli') {
        statTotal.textContent = currentData.length.toLocaleString('id-ID');
        statTotalSub.style.display = 'block';
        statTotalSub.textContent = 'Rekening Lunas Dibeli YKK';
        
        const totalBayarSemua = currentData.reduce((sum, r) => sum + (parseFloat(r.TOTAL_BAYAR) || 0), 0);
        statTotalJumlah.textContent = formatRupiah(totalBayarSemua || grandTotal);
        statTotalJumlahSub.style.display = 'block';
        statTotalJumlahSub.textContent = `Pokok Air: ${formatRupiah(grandTotal)}`;
        statCardSisa.style.display = 'none';
    } else {
        statTotal.textContent = currentData.length.toLocaleString('id-ID');
        statTotalSub.style.display = 'none';
        statTotalJumlah.textContent = formatRupiah(grandTotal);
        statTotalJumlahSub.style.display = 'none';
        statCardSisa.style.display = 'none';

        const tunggakanCount = currentData.filter(d => d.ALASAN && d.ALASAN.startsWith('Tunggakan')).length;
        statTunggakan.textContent = tunggakanCount.toLocaleString('id-ID');
    }
}

function showEmptyState() {
    tableBody.innerHTML = '<tr><td colspan="12" style="text-align: center; padding: 3rem; color: var(--text-secondary);">Silakan klik tombol <strong>"Tampilkan Data"</strong> untuk memuat data dari database.</td></tr>';
    statTotal.textContent = '0';
    statTotalJumlah.textContent = 'Rp 0';
    statTotalSub.style.display = 'none';
    statTotalJumlahSub.style.display = 'none';
    pageCount.textContent = '0';
    statTunggakan.textContent = '0';
    statCardSisa.style.display = 'none';
    if (budgetProgressSection) budgetProgressSection.style.display = 'none';
    currentData = []; // Reset stored data
    searchInput.value = '';
}

// Tab Switching
function switchTab(tabId) {
    currentTab = tabId;
    
    // Update Active Class
    navItems.forEach(btn => btn.classList.remove('active'));
    const activeNav = document.querySelector(`[data-tab="${tabId}"]`);
    if (activeNav) activeNav.classList.add('active');
    
    const tableContainer = document.querySelector('.table-container');
    
    // Update Title and UI Elements
    if (tabId === 'beli') {
        pageTitle.textContent = 'Rencana Beli YKK';
        if (thAlasan) thAlasan.style.display = 'none';
        if (thTglBayar) thTglBayar.style.display = 'none';
        if (thDenda) thDenda.style.display = 'none';
        if (statCardAlasan) statCardAlasan.style.display = 'none';
        budgetPanel.style.display = 'flex';
        statsGrid.style.display = 'grid';
        if (tableContainer) tableContainer.style.display = 'block';
        if (otomasiSection) otomasiSection.style.display = 'none';
        if (backupSection) backupSection.style.display = 'none';
        if (queryContainerPanel) queryContainerPanel.style.display = 'block';
        if (maxBudget > 0 && currentData.length > 0) {
            statCardSisa.style.display = 'flex';
            budgetProgressSection.style.display = 'flex';
        }
        showEmptyState();
        updatePeriodeUI();
    } else if (tabId === 'batal') {
        pageTitle.textContent = 'Rencana Pembatalan YKK';
        if (thAlasan) thAlasan.style.display = 'table-cell';
        if (thTglBayar) thTglBayar.style.display = 'none';
        if (thDenda) thDenda.style.display = 'none';
        if (statCardAlasan) statCardAlasan.style.display = 'flex';
        budgetPanel.style.display = 'none';
        statCardSisa.style.display = 'none';
        statsGrid.style.display = 'grid';
        if (tableContainer) tableContainer.style.display = 'block';
        if (otomasiSection) otomasiSection.style.display = 'none';
        if (backupSection) backupSection.style.display = 'none';
        if (queryContainerPanel) queryContainerPanel.style.display = 'block';
        if (thKuota) thKuota.style.display = 'none';
        showEmptyState();
        updatePeriodeUI();
    } else if (tabId === 'dibeli') {
        pageTitle.textContent = 'Data Rekening Dibeli YKK';
        if (thAlasan) thAlasan.style.display = 'none';
        if (thTglBayar) thTglBayar.style.display = 'table-cell';
        if (thDenda) thDenda.style.display = 'table-cell';
        if (statCardAlasan) statCardAlasan.style.display = 'none';
        budgetPanel.style.display = 'none';
        statCardSisa.style.display = 'none';
        statsGrid.style.display = 'grid';
        if (tableContainer) tableContainer.style.display = 'block';
        if (otomasiSection) otomasiSection.style.display = 'none';
        if (backupSection) backupSection.style.display = 'none';
        if (queryContainerPanel) queryContainerPanel.style.display = 'block';
        if (thKuota) thKuota.style.display = 'none';
        showEmptyState();
        stopPipelineTabAutoPoller();
        stopBackupTabAutoPoller();
    } else if (tabId === 'pipeline' || tabId === 'otomasi') {
        pageTitle.textContent = 'Master Closing Pipeline (6-Tahap Otomasi)';
        budgetPanel.style.display = 'none';
        statsGrid.style.display = 'none';
        if (tableContainer) tableContainer.style.display = 'none';
        if (backupSection) backupSection.style.display = 'none';
        const pipelineSection = document.getElementById('pipeline-section');
        if (pipelineSection) pipelineSection.style.display = 'block';
        if (queryContainerPanel) queryContainerPanel.style.display = 'none';
        
        stopBackupTabAutoPoller();
        loadAutomationConfig();
        loadPipelineLogs();
        startPipelineTabAutoPoller();
    } else if (tabId === 'backup') {
        pageTitle.textContent = 'Pencadangan Database Otomatis';
        budgetPanel.style.display = 'none';
        statsGrid.style.display = 'none';
        if (tableContainer) tableContainer.style.display = 'none';
        const pipelineSection = document.getElementById('pipeline-section');
        if (pipelineSection) pipelineSection.style.display = 'none';
        if (backupSection) backupSection.style.display = 'block';
        if (queryContainerPanel) queryContainerPanel.style.display = 'none';
        
        stopPipelineTabAutoPoller();
        loadBackupData();
        startBackupTabAutoPoller();
        startNightlyBackupCountdown();
    }
}

// Event Listeners
navItems.forEach(item => {
    item.addEventListener('click', (e) => {
        const tabId = e.currentTarget.getAttribute('data-tab');
        switchTab(tabId);
    });
});

btnToggleQuery.addEventListener('click', () => {
    const isHidden = queryContent.style.display === 'none';
    queryContent.style.display = isHidden ? 'block' : 'none';
    btnToggleQuery.innerHTML = isHidden ? '<i class="ph ph-caret-up"></i>' : '<i class="ph ph-caret-down"></i>';
});

btnRefresh.addEventListener('click', () => {
    fetchData(currentTab);
});

btnLoadData.addEventListener('click', () => {
    fetchData(currentTab);
});

// Event listener saat user memilih tanggal di date picker
datePicker.addEventListener('change', () => {
    updatePeriodeUI();
    fetchData(currentTab);
});

// Klik box date picker untuk langsung membuka kalender
const datePickerBox = document.querySelector('.date-picker-box');
if (datePickerBox) {
    datePickerBox.addEventListener('click', (e) => {
        if (e.target !== datePicker && typeof datePicker.showPicker === 'function') {
            try {
                datePicker.showPicker();
            } catch (err) {
                datePicker.focus();
            }
        }
    });
}

// Budget Input Event Handler (Format Rupiah & Auto Recalculate)
function setMaxBudget(amount, updateInput = true) {
    maxBudget = amount;
    if (updateInput) {
        budgetInput.value = amount > 0 ? amount.toLocaleString('id-ID') : '';
    }

    // Update active class on preset chips
    budgetPresetChips.forEach(chip => {
        const chipAmt = parseInt(chip.getAttribute('data-amount'), 10);
        if (chipAmt === maxBudget) {
            chip.classList.add('active');
        } else {
            chip.classList.remove('active');
        }
    });

    if (currentData.length > 0 && currentTab === 'beli') {
        applyBudgetAllocation();
        const filtered = getFilteredData();
        renderTable(filtered, currentTab);
    }
}

budgetInput.addEventListener('input', (e) => {
    const rawDigits = e.target.value.replace(/\D/g, '');
    if (!rawDigits || rawDigits === '0') {
        setMaxBudget(0, false);
        e.target.value = '';
    } else {
        const num = parseInt(rawDigits, 10);
        setMaxBudget(num, false);
        e.target.value = num.toLocaleString('id-ID');
    }
});

btnClearBudget.addEventListener('click', () => {
    setMaxBudget(0, true);
});

budgetPresetChips.forEach(chip => {
    chip.addEventListener('click', () => {
        const amt = parseInt(chip.getAttribute('data-amount'), 10);
        setMaxBudget(amt, true);
    });
});

if (toggleOnlyKuota) {
    toggleOnlyKuota.addEventListener('change', () => {
        if (currentData.length > 0 && currentTab === 'beli') {
            const filtered = getFilteredData();
            renderTable(filtered, currentTab);
        }
    });
}

// Search functionality
searchInput.addEventListener('input', () => {
    const filtered = getFilteredData();
    renderTable(filtered, currentTab);
});

// Export functionality
btnExport.addEventListener('click', () => {
    if (currentData.length === 0) {
        alert('Tidak ada data untuk diekspor.');
        return;
    }
    
    // Get currently filtered data
    const dataToExport = getFilteredData();
    
    if (dataToExport.length === 0) {
        alert('Tidak ada data yang sesuai filter untuk diekspor.');
        return;
    }
    
    const headers = ['NO_PDAM', 'NAMA_PELANGGAN', 'PERIODE'];
    if (currentTab === 'dibeli') headers.push('TGL_BAYAR');
    headers.push('LOKASI_BAYAR', 'GOLONGAN');
    if (currentTab === 'batal') headers.push('ALASAN');
    if (currentTab === 'beli' && maxBudget > 0) {
        headers.push('STATUS_KUOTA');
    }
    headers.push('RK', 'NON_AIR');
    if (currentTab === 'dibeli') {
        headers.push('DENDA_YKK', 'TOTAL_BAYAR');
    } else {
        headers.push('JUMLAH');
    }
    if (currentTab === 'beli' && maxBudget > 0) {
        headers.push('JUMLAH_KUMULATIF');
    }
    
    const csvRows = [headers.join(',')];
    
    dataToExport.forEach(row => {
        const rk = parseFloat(row.RK) || 0;
        const nonAir = parseFloat(row.NON_AIR) || 0;
        const materai = parseFloat(row.MATERAI) || 0;
        const tagihanPokok = (rk + nonAir + materai);
        const jumlah = row._jumlah !== undefined ? row._jumlah : tagihanPokok;
        
        const cols = [
            `"${row.NO_PDAM}"`,
            `"${(row.NAMA || '').replace(/"/g, '""')}"`,
            `"${row.PERIODE}"`
        ];
        
        if (currentTab === 'dibeli') cols.push(`"${row.TGL_BAYAR || ''}"`);
        cols.push(`"${row.LOKBAY_ID}"`, `"${row.STGOL_ID}"`);
        
        if (currentTab === 'batal') cols.push(`"${row.ALASAN || ''}"`);
        if (currentTab === 'beli' && maxBudget > 0) {
            cols.push(`"${row.masuk_kuota ? 'MASUK KUOTA' : 'MELEBIHI BUDGET'}"`);
        }
        
        cols.push(rk, nonAir);

        if (currentTab === 'dibeli') {
            const denda = parseFloat(row.DENDA_YKK) || 0;
            const totalBayar = parseFloat(row.TOTAL_BAYAR) || (jumlah + denda);
            cols.push(denda, totalBayar);
        } else {
            cols.push(jumlah);
        }
        
        if (currentTab === 'beli' && maxBudget > 0) {
            cols.push(row._cum_sum || jumlah);
        }
        
        csvRows.push(cols.join(','));
    });
    
    const csvString = csvRows.join('\n');
    const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    
    const budgetSuffix = (currentTab === 'beli' && maxBudget > 0) ? `_budget_${maxBudget}` : '';
    link.setAttribute('href', url);
    link.setAttribute('download', `data_${currentTab}${budgetSuffix}_${new Date().toISOString().slice(0,10)}.csv`);
    link.style.display = 'none';
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
});

// =========================================================================
// Automation & Scheduling Functions
// =========================================================================

let countdownInterval = null;

function formatDatetimeForInput(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function getDefault21stSchedule(periodeStr) {
    let pYear = parseInt(periodeStr.substring(0, 4), 10);
    let pMonth = parseInt(periodeStr.substring(4, 6), 10) + 1;
    if (pMonth > 12) {
        pMonth = 1;
        pYear++;
    }
    const d = new Date(pYear, pMonth - 1, 21, 0, 5, 0);
    return formatDatetimeForInput(d);
}

let isCheckingCron = false;

async function triggerDueCronCheck() {
    if (isCheckingCron) return;
    isCheckingCron = true;
    try {
        if (countdownDetail) countdownDetail.textContent = 'Menjalankan eksekusi otomatis...';
        if (autoScheduleBadge) {
            autoScheduleBadge.className = 'badge badge-warning';
            autoScheduleBadge.textContent = 'SEDANG MEMPROSES...';
        }
        if (pipelineLiveIndicator) {
            pipelineLiveIndicator.textContent = 'AUTO RUNNING';
            pipelineLiveIndicator.className = 'badge badge-warning';
        }
        if (pipelineStatusBadge) {
            pipelineStatusBadge.innerHTML = '<i class="ph ph-spinner spinner"></i> MEMPROSES OTOMATIS...';
            pipelineStatusBadge.className = 'badge badge-warning';
        }
        if (pipelineConsoleOutput) {
            pipelineConsoleOutput.textContent = '>>> [OTOMASI] Menerima pemicu jadwal eksekusi otomatis...\n>>> Memanggil Master Pipeline 6-Tahap via check_cron...\n';
        }

        startPipelineStopwatch();
        updatePipelineProgressUI(0, 'RUNNING', 'Otomasi: Menjalankan Master Pipeline...', false);

        const res = await fetch('api.php?action=check_cron');
        const json = await res.json();
        if (json.status === 'executed') {
            if (countdownTimer) countdownTimer.textContent = 'SELESAI';
            if (countdownDetail) countdownDetail.textContent = json.message || 'Eksekusi otomatis sukses dijalankan!';
            if (autoScheduleBadge) {
                autoScheduleBadge.className = 'badge badge-success';
                autoScheduleBadge.textContent = 'SUKSES DIEKSEKUSI';
            }
            if (pipelineLiveIndicator) {
                pipelineLiveIndicator.textContent = 'IDLE';
                pipelineLiveIndicator.className = 'badge badge-secondary';
            }
            if (pipelineStatusBadge) {
                pipelineStatusBadge.innerHTML = '<i class="ph ph-check-circle"></i> SUKSES PENUH';
                pipelineStatusBadge.className = 'badge badge-success';
            }
            if (pipelineConsoleOutput && json.data && json.data.log) {
                pipelineConsoleOutput.textContent = json.data.log;
            }
            stopPipelineStopwatch('Selesai');
            updatePipelineProgressUI(5, 'SUCCESS', 'Master Pipeline Terjadwal Sukses Penuh (6/6 Tahap)', true);
            loadPipelineLogs();
            loadAutomationConfig();
            loadExecutionLogs();
        } else {
            stopPipelineStopwatch();
            loadAutomationConfig();
            loadExecutionLogs();
        }
    } catch (e) {
        console.error('Check cron error:', e);
        stopPipelineStopwatch('Error');
    } finally {
        setTimeout(() => { isCheckingCron = false; }, 10000);
    }
}

function startCountdownTimer(targetDateStr, status) {
    if (countdownInterval) clearInterval(countdownInterval);
    
    if (!targetDateStr || status === 'SUCCESS') {
        if (countdownTimer) countdownTimer.textContent = 'SELESAI';
        if (countdownDetail) countdownDetail.textContent = 'Transaksi periode ini sukses dieksekusi.';
        if (autoScheduleBadge) {
            autoScheduleBadge.className = 'badge badge-success';
            autoScheduleBadge.textContent = 'SUKSES DIEKSEKUSI';
        }
        return;
    }

    const targetTime = new Date(targetDateStr.replace(' ', 'T')).getTime();

    function update() {
        const now = new Date().getTime();
        const diff = targetTime - now;

        if (diff <= 0) {
            if (countdownTimer) countdownTimer.textContent = '00:00:00 (Jatuh Tempo)';
            if (autoScheduleBadge) {
                autoScheduleBadge.className = 'badge badge-warning';
                autoScheduleBadge.textContent = 'MENGEKSEKUSI...';
            }
            if (countdownInterval) {
                clearInterval(countdownInterval);
                countdownInterval = null;
            }
            triggerDueCronCheck();
            return;
        }

        const days = Math.floor(diff / (1000 * 60 * 60 * 24));
        const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((diff % (1000 * 60)) / 1000);

        let timerText = '';
        if (days > 0) timerText += `${days}h `;
        timerText += `${String(hours).padStart(2, '0')}j ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}d`;

        if (countdownTimer) countdownTimer.textContent = timerText;
        if (countdownDetail) countdownDetail.textContent = `Target: ${targetDateStr}`;
        if (autoScheduleBadge) {
            autoScheduleBadge.className = 'badge badge-info';
            autoScheduleBadge.textContent = `PENDING (${days > 0 ? days + ' hari lagi' : (hours > 0 ? hours + ' jam ' : '') + minutes + 'm ' + seconds + 's'})`;
        }
    }

    update();
    countdownInterval = setInterval(update, 1000);
}

async function loadAutomationConfig() {
    try {
        const res = await fetch('api.php?action=get_config');
        const json = await res.json();
        const displayAuto = document.getElementById('display-auto-periode');
        const targetPeriode = json.target_periode_eksekusi || '202608';

        if (cfgPeriode) {
            cfgPeriode.value = targetPeriode;
        }
        if (displayAuto) {
            displayAuto.textContent = `${targetPeriode} (Aktif SIMPADU: ${json.periode_aktif_db || '-'})`;
        }

        const ykkConfigTbody = document.getElementById('ykk-config-tbody');

        if (json.status === 'success' && json.data && json.data.length > 0) {
            // Prioritaskan konfigurasi PENDING, atau yang sesuai periode target
            let activeCfg = json.data.find(c => c.status === 'PENDING');
            if (!activeCfg) {
                activeCfg = json.data.find(c => c.periode === targetPeriode);
            }
            if (!activeCfg) {
                activeCfg = json.data[0];
            }

            if (cfgBudget && !cfgBudget.value && parseFloat(activeCfg.budget_plafon) > 0) {
                cfgBudget.value = parseInt(activeCfg.budget_plafon, 10).toLocaleString('id-ID');
            }
            if (cfgJadwal && activeCfg.jadwal_eksekusi) {
                const dt = new Date(activeCfg.jadwal_eksekusi.replace(' ', 'T'));
                cfgJadwal.value = formatDatetimeForInput(dt);
            }
            startCountdownTimer(activeCfg.jadwal_eksekusi, activeCfg.status);

            // Render Tabel Daftar Konfigurasi Antrean (ykk_config)
            if (ykkConfigTbody) {
                let html = '';
                json.data.forEach(cfg => {
                    let badgeClass = 'badge-info';
                    if (cfg.status === 'SUCCESS') badgeClass = 'badge-success';
                    else if (cfg.status === 'FAILED') badgeClass = 'badge-danger';
                    else if (cfg.status === 'RUNNING') badgeClass = 'badge-warning';

                    const plafonNominal = parseFloat(cfg.budget_plafon) > 0 
                        ? formatRupiah(cfg.budget_plafon) 
                        : '<span style="color: var(--text-secondary);">Tanpa Batas</span>';
                    
                    const waktuEksekusi = cfg.waktu_eksekusi ? cfg.waktu_eksekusi : '-';
                    const catatan = cfg.pesan_terakhir ? cfg.pesan_terakhir : '-';

                    html += `
                        <tr>
                            <td><strong>#${cfg.id}</strong></td>
                            <td><span class="badge badge-purple">${cfg.periode}</span></td>
                            <td><strong>${cfg.jadwal_eksekusi}</strong></td>
                            <td style="text-align: right; font-weight: 600;">${plafonNominal}</td>
                            <td><span class="badge ${badgeClass}">${cfg.status}</span></td>
                            <td><small style="color: var(--text-secondary);">${cfg.waktu_input || '-'}</small></td>
                            <td><small style="color: var(--text-secondary);">${waktuEksekusi}</small></td>
                            <td><small style="max-width: 180px; display: inline-block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${catatan}">${catatan}</small></td>
                        </tr>
                    `;
                });
                ykkConfigTbody.innerHTML = html;
            }
        } else {
            if (cfgJadwal && !cfgJadwal.value) {
                cfgJadwal.value = getDefault21stSchedule(targetPeriode);
            }
            startCountdownTimer(cfgJadwal ? cfgJadwal.value.replace('T', ' ') : null, 'PENDING');
            if (ykkConfigTbody) {
                ykkConfigTbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-secondary); padding: 1.5rem;">Belum ada jadwal antrean tercatat di ykk_config.</td></tr>';
            }
        }
    } catch (e) {
        console.error('Gagal mengambil konfigurasi otomasi:', e);
    }
}

if (btnRefreshConfigs) {
    btnRefreshConfigs.addEventListener('click', () => {
        loadAutomationConfig();
    });
}

// Preset Buttons
if (btnPreset2Min) {
    btnPreset2Min.addEventListener('click', () => {
        const now = new Date();
        now.setMinutes(now.getMinutes() + 2);
        if (cfgJadwal) {
            cfgJadwal.value = formatDatetimeForInput(now);
            startCountdownTimer(cfgJadwal.value.replace('T', ' ') + ':00', 'PENDING');
        }
    });
}

if (btnPreset21st) {
    btnPreset21st.addEventListener('click', () => {
        const p = (cfgPeriode.value || getSelectedPeriode()).trim();
        if (cfgJadwal && p.length === 6) {
            cfgJadwal.value = getDefault21stSchedule(p);
            startCountdownTimer(cfgJadwal.value.replace('T', ' ') + ':00', 'PENDING');
        }
    });
}

if (cfgBudget) {
    cfgBudget.addEventListener('input', (e) => {
        let val = e.target.value.replace(/\D/g, '');
        if (val) {
            e.target.value = parseInt(val, 10).toLocaleString('id-ID');
        } else {
            e.target.value = '';
        }
    });
}

if (formYkkConfig) {
    formYkkConfig.addEventListener('submit', async (e) => {
        e.preventDefault();
        const periode = (cfgPeriode.value || '').trim();
        const rawBudget = (cfgBudget.value || '').replace(/\D/g, '');
        const budget = rawBudget ? parseFloat(rawBudget) : 0;
        let jadwal = cfgJadwal ? cfgJadwal.value : '';

        if (!periode || periode.length !== 6) {
            alert('Format periode tidak valid! Harus 6 digit YYYYMM (contoh: 202409).');
            return;
        }

        if (jadwal) {
            jadwal = jadwal.replace('T', ' ');
            if (jadwal.length === 16) jadwal += ':00';
        }

        const btnSave = document.getElementById('btn-save-config');
        btnSave.disabled = true;
        btnSave.innerHTML = '<i class="ph ph-spinner spinner"></i> Menyimpan...';

        try {
            const res = await fetch('api.php?action=save_config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    periode: periode, 
                    budget_plafon: budget, 
                    jadwal_eksekusi: jadwal,
                    user_id: 1 
                })
            });
            const json = await res.json();
            if (json.status === 'success') {
                alert(json.message || 'Jadwal dan kuota berhasil disimpan ke antrean eksekusi!');
                startCountdownTimer(jadwal, 'PENDING');
                loadAutomationConfig();
            } else {
                alert('Gagal: ' + (json.error || 'Terjadi kesalahan sistem'));
            }
        } catch (err) {
            alert('Terjadi kesalahan jaringan: ' + err.message);
        } finally {
            btnSave.disabled = false;
            btnSave.innerHTML = '<i class="ph ph-floppy-disk"></i> Simpan Jadwal Antrean';
        }
    });
}

if (btnRunSimulasi) {
    btnRunSimulasi.addEventListener('click', async () => {
        const periode = (cfgPeriode.value || '').trim();
        const rawBudget = (cfgBudget.value || '').replace(/\D/g, '');
        const budget = rawBudget ? parseFloat(rawBudget) : 0;

        if (!periode || periode.length !== 6) {
            alert('Harap isi periode yang valid (contoh: 202409) untuk simulasi.');
            return;
        }

        btnRunSimulasi.disabled = true;
        btnRunSimulasi.innerHTML = '<i class="ph ph-spinner spinner"></i> Menghitung...';
        simStatusBadge.className = 'badge badge-warning';
        simStatusBadge.textContent = 'Memproses Simulasi...';

        try {
            const res = await fetch(`api.php?action=run_simulation&periode=${periode}&budget=${budget}`);
            const json = await res.json();
            if (json.status === 'success' && json.data) {
                const d = json.data;
                simTotalRek.textContent = `${parseInt(d.total_rekening || 0).toLocaleString('id-ID')} Rekening`;
                simTotalTagihan.textContent = formatRupiah(d.total_tagihan || 0);
                simTotalDenda.textContent = formatRupiah(d.total_denda || 0);
                simTotalBayar.textContent = formatRupiah(d.total_bayar_ykk || 0);
                simSisaBudget.textContent = budget > 0 ? formatRupiah(d.sisa_budget || 0) : 'Tanpa Batas';

                simStatusBadge.className = 'badge badge-success';
                simStatusBadge.textContent = `Selesai (${d.durasi_detik}s)`;
            } else {
                simStatusBadge.className = 'badge badge-danger';
                simStatusBadge.textContent = 'Simulasi Gagal';
                alert('Simulasi gagal: ' + (json.error || 'Unknown error'));
            }
        } catch (err) {
            simStatusBadge.className = 'badge badge-danger';
            simStatusBadge.textContent = 'Koneksi Error';
            alert('Kesalahan: ' + err.message);
        } finally {
            btnRunSimulasi.disabled = false;
            btnRunSimulasi.innerHTML = '<i class="ph ph-play-circle"></i> Uji Simulasi';
        }
    });
}

if (btnManualExecute) {
    btnManualExecute.addEventListener('click', async () => {
        const periode = (cfgPeriode.value || '').trim();
        const rawBudget = (cfgBudget.value || '').replace(/\D/g, '');
        const budget = rawBudget ? parseFloat(rawBudget) : 0;

        if (!periode || periode.length !== 6) {
            alert('Harap isi periode yang valid (contoh: 202409).');
            return;
        }

        const konfirmasi = confirm(
            `PERHATIAN: Anda akan mengeksekusi pembelian rekening YKK periode ${periode} saat ini juga!\n\n` +
            `Nominal Budget: ${budget > 0 ? 'Rp ' + budget.toLocaleString('id-ID') : 'Tanpa Batas (Semua)'}\n\n` +
            `Apakah Anda yakin ingin melanjutkan transaksi sekarang?`
        );

        if (!konfirmasi) return;

        btnManualExecute.disabled = true;
        btnManualExecute.innerHTML = '<i class="ph ph-spinner spinner"></i> Mengeksekusi Transaksi Database...';

        try {
            const res = await fetch('api.php?action=run_execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ periode: periode, budget_plafon: budget, user_id: 1 })
            });
            const json = await res.json();
            if (json.status === 'success' && json.data) {
                const d = json.data;
                alert(`SUKSES! Transaksi berhasil diproses:\n- Total Rekening: ${parseInt(d.total_rekening).toLocaleString('id-ID')}\n- Total Pokok Air: Rp ${parseInt(d.total_tagihan).toLocaleString('id-ID')}\n- Total Denda YKK: Rp ${parseInt(d.total_denda).toLocaleString('id-ID')}\n- Waktu Proses: ${d.durasi_detik} detik.`);
                loadExecutionLogs();
            } else {
                alert('Eksekusi Gagal: ' + (json.error || 'Terjadi kesalahan transaksi SQL'));
            }
        } catch (err) {
            alert('Kesalahan jaringan: ' + err.message);
        } finally {
            btnManualExecute.disabled = false;
            btnManualExecute.innerHTML = '<i class="ph ph-lightning"></i> Eksekusi Manual Sekarang (Emergency Run)';
        }
    });
}

async function loadExecutionLogs() {
    if (!historyTableBody) return;
    try {
        historyTableBody.innerHTML = '<tr><td colspan="10" style="text-align: center; padding: 1.5rem;"><i class="ph ph-spinner spinner"></i> Memuat riwayat...</td></tr>';
        const res = await fetch('api.php?action=get_logs');
        const json = await res.json();
        
        if (json.status === 'success' && json.data && json.data.length > 0) {
            let html = '';
            json.data.forEach(log => {
                const isSuccess = log.status === 'SUCCESS';
                const statusBadge = isSuccess 
                    ? '<span class="badge badge-success">SUKSES</span>' 
                    : '<span class="badge badge-danger">GAGAL</span>';
                
                const durasi = parseFloat(log.durasi_detik || 0).toFixed(1) + 's';
                const totalRek = parseInt(log.total_rekening || 0).toLocaleString('id-ID');
                const plafon = parseFloat(log.budget_plafon) > 0 ? formatRupiah(log.budget_plafon) : 'Tanpa Batas';

                html += `
                    <tr>
                        <td><strong>${log.waktu_mulai}</strong></td>
                        <td><span class="badge badge-purple">${log.periode}</span></td>
                        <td>${statusBadge}</td>
                        <td style="font-weight: 600;">${totalRek} rek</td>
                        <td>${formatRupiah(log.total_tagihan || 0)}</td>
                        <td class="text-warning">${formatRupiah(log.total_denda || 0)}</td>
                        <td class="text-accent" style="font-weight: 700;">${formatRupiah(log.total_bayar || 0)}</td>
                        <td><small>${plafon}</small></td>
                        <td>${durasi}</td>
                        <td><small class="badge badge-info">${log.executed_by || 'CRON'}</small></td>
                    </tr>
                `;
            });
            historyTableBody.innerHTML = html;
        } else {
            historyTableBody.innerHTML = '<tr><td colspan="10" style="text-align: center; padding: 2rem; color: var(--text-secondary);">Belum ada riwayat transaksi eksekusi tercatat.</td></tr>';
        }
    } catch (e) {
        historyTableBody.innerHTML = `<tr><td colspan="10" style="text-align: center; color: #ef4444; padding: 1.5rem;">Gagal memuat riwayat: ${e.message}</td></tr>`;
    }
}

if (btnRefreshHistory) {
    btnRefreshHistory.addEventListener('click', () => {
        loadExecutionLogs();
    });
}

// =========================================================================
// Backup & Database Archival Functions + Live Restore Progress Tracker
// =========================================================================

let backupTabAutoPoller = null;

async function checkAndRenderRestoreStatus() {
    const cardProgress = document.getElementById('card-restore-live-progress');
    if (!cardProgress) return;

    try {
        const res = await fetch('api.php?action=get_restore_status');
        const json = await res.json();
        if (json.status === 'success') {
            if (json.is_active || json.is_finished) {
                cardProgress.style.display = 'block';

                const fnEl = document.getElementById('card-restore-filename');
                const phaseTitle = document.getElementById('card-restore-phase-title');
                const timerEl = document.getElementById('card-restore-live-timer');
                const pctEl = document.getElementById('card-restore-pct');
                const barEl = document.getElementById('card-restore-progress-bar');
                const tickerEl = document.getElementById('card-restore-query-ticker');
                const tableBadge = document.getElementById('card-restore-active-table-badge');

                if (fnEl) fnEl.textContent = json.source_file || 'simpadu_xxxx.sql.gz';

                const m = String(Math.floor(json.elapsed_seconds / 60)).padStart(2, '0');
                const s = String(json.elapsed_seconds % 60).padStart(2, '0');
                if (timerEl) timerEl.innerHTML = `<i class="ph ph-timer"></i> ${m}:${s}`;

                if (json.is_finished) {
                    if (phaseTitle) phaseTitle.innerHTML = `<i class="ph ph-check-circle" style="color: #10b981;"></i> Pemulihan Database Selesai Sukses (${json.finish_duration} detik)`;
                    if (pctEl) { pctEl.textContent = '100%'; pctEl.style.color = '#10b981'; }
                    if (barEl) { barEl.style.width = '100%'; barEl.style.background = '#10b981'; }
                    if (tableBadge) { tableBadge.className = 'badge badge-success'; tableBadge.textContent = 'Selesai Penuh'; }

                    for (let i = 1; i <= 4; i++) {
                        updatePageRestoreStepUI(i, 'SUCCESS', 'Selesai');
                    }
                    if (tickerEl) tickerEl.textContent = json.last_log || 'Pemulihan database telah selesai dengan sukses.';
                } else {
                    // Masih Aktif
                    if (phaseTitle) phaseTitle.innerHTML = `<span class="pipeline-radar-pulse" style="background: #ef4444; box-shadow: 0 0 10px #ef4444;"></span> Pemulihan Database: <span style="color: #fff; font-family: monospace;">${json.source_file || 'simpadu'}</span>`;
                    
                    // Step 1: Safety Snapshot
                    if (json.has_safety_snapshot) {
                        updatePageRestoreStepUI(1, 'SUCCESS', 'Snapshot Siap');
                    } else {
                        updatePageRestoreStepUI(1, 'RUNNING', 'Snapshot...');
                    }

                    // Step 2: Dekompresi
                    if (json.active_table || json.has_safety_snapshot) {
                        updatePageRestoreStepUI(2, 'SUCCESS', 'Dekompresi Selesai');
                    } else {
                        updatePageRestoreStepUI(2, 'STANDBY', 'Menunggu');
                    }

                    // Step 3: Impor MySQL
                    if (json.active_table) {
                        updatePageRestoreStepUI(3, 'RUNNING', `Tabel: ${json.active_table}`);
                        const desc3 = document.getElementById('page-restore-desc-3');
                        if (desc3) desc3.innerHTML = `Mengisi tabel <code>${json.active_table}</code>`;
                    } else {
                        updatePageRestoreStepUI(3, 'RUNNING', 'Memproses...');
                    }

                    // Step 4: Finalisasi
                    updatePageRestoreStepUI(4, 'STANDBY', 'Menunggu');

                    if (tableBadge) {
                        tableBadge.className = 'badge badge-info';
                        tableBadge.textContent = json.active_table ? `Tabel: ${json.active_table}` : 'Memproses...';
                    }

                    if (pctEl) { pctEl.textContent = '85%'; pctEl.style.color = '#fca5a5'; }
                    if (barEl) { barEl.style.width = '85%'; barEl.style.background = 'linear-gradient(90deg, #f97316, #ef4444, #ec4899)'; }

                    if (tickerEl && json.query_snippet) {
                        tickerEl.textContent = `[${json.timestamp || ''}] ${json.query_snippet}`;
                    }
                }
            } else {
                cardProgress.style.display = 'none';
            }
        }
    } catch (e) {
        // ignore background poll errors
    }
}

function updatePageRestoreStepUI(stepNum, status, badgeText) {
    const card = document.getElementById(`page-restore-step-${stepNum}`);
    if (!card) return;
    const badge = card.querySelector('.step-status-badge');
    const meta = document.getElementById(`page-restore-meta-${stepNum}`);

    card.className = 'step-card';
    if (status === 'RUNNING') {
        card.classList.add('active');
        if (badge) {
            badge.className = 'badge badge-warning step-status-badge';
            badge.textContent = badgeText || 'PROSES';
        }
    } else if (status === 'SUCCESS') {
        card.classList.add('success');
        if (badge) {
            badge.className = 'badge badge-success step-status-badge';
            badge.textContent = badgeText || 'SUKSES';
        }
    } else {
        if (badge) {
            badge.className = 'badge badge-secondary step-status-badge';
            badge.textContent = badgeText || 'STANDBY';
        }
    }
    if (meta && badgeText) meta.textContent = badgeText;
}

async function checkAndRenderBackupStatus() {
    const cardProgress = document.getElementById('card-backup-live-progress');
    if (!cardProgress) return;

    try {
        const res = await fetch('api.php?action=get_backup_status');
        const json = await res.json();
        if (json.status === 'success') {
            if (json.is_active || json.is_finished) {
                cardProgress.style.display = 'block';

                const fnEl = document.getElementById('card-backup-filename');
                const phaseTitle = document.getElementById('card-backup-phase-title');
                const timerEl = document.getElementById('card-backup-live-timer');
                const pctEl = document.getElementById('card-backup-pct');
                const barEl = document.getElementById('card-backup-progress-bar');
                const tickerEl = document.getElementById('card-backup-query-ticker');
                const tableBadge = document.getElementById('card-backup-active-table-badge');

                if (fnEl) fnEl.textContent = json.filename || 'simpadu_xxxx.sql.gz';

                const m = String(Math.floor(json.elapsed_seconds / 60)).padStart(2, '0');
                const s = String(json.elapsed_seconds % 60).padStart(2, '0');
                if (timerEl) timerEl.innerHTML = `<i class="ph ph-timer"></i> ${m}:${s}`;

                if (json.is_finished) {
                    if (phaseTitle) phaseTitle.innerHTML = `<i class="ph ph-check-circle" style="color: #10b981;"></i> Pencadangan Database Selesai Sukses (${json.current_size_mb} MB)`;
                    if (pctEl) { pctEl.textContent = '100%'; pctEl.style.color = '#10b981'; }
                    if (barEl) { barEl.style.width = '100%'; barEl.style.background = '#10b981'; }
                    if (tableBadge) { tableBadge.className = 'badge badge-success'; tableBadge.textContent = 'Selesai Penuh'; }
                    if (tickerEl) tickerEl.textContent = json.last_log || 'Pencadangan database telah selesai dengan sukses.';
                } else {
                    // Masih Aktif
                    if (phaseTitle) phaseTitle.innerHTML = `<span class="pipeline-radar-pulse" style="background: #3b82f6; box-shadow: 0 0 10px #3b82f6;"></span> Pencadangan Database: <span style="color: #fff; font-family: monospace;">${json.filename || 'simpadu'}</span> (${json.current_size_mb} MB / ~${json.estimated_total_mb} MB)`;
                    
                    if (tableBadge) {
                        tableBadge.className = 'badge badge-primary';
                        tableBadge.textContent = json.active_table ? `Tabel: ${json.active_table}` : 'mysqldump dump...';
                    }

                    const pctStr = `${json.percent || 0}%`;
                    if (pctEl) { pctEl.textContent = pctStr; pctEl.style.color = '#93c5fd'; }
                    if (barEl) { barEl.style.width = pctStr; barEl.style.background = 'linear-gradient(90deg, #06b6d4, #3b82f6, #6366f1)'; }

                    if (tickerEl) {
                        if (json.query_snippet) {
                            tickerEl.textContent = `[${json.timestamp || ''}] ${json.query_snippet}`;
                        } else if (json.last_log) {
                            tickerEl.textContent = json.last_log;
                        }
                    }
                }
            } else {
                cardProgress.style.display = 'none';
            }
        }
    } catch (e) {
        // ignore background poll errors
    }
}

function startBackupTabAutoPoller() {
    if (backupTabAutoPoller) clearInterval(backupTabAutoPoller);
    checkAndRenderRestoreStatus();
    checkAndRenderBackupStatus();
    backupTabAutoPoller = setInterval(() => {
        checkAndRenderRestoreStatus();
        checkAndRenderBackupStatus();
    }, 2000);
}

function stopBackupTabAutoPoller() {
    if (backupTabAutoPoller) {
        clearInterval(backupTabAutoPoller);
        backupTabAutoPoller = null;
    }
}

async function loadBackupData() {
    if (!backupTableBody) return;
    try {
        backupTableBody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 2rem; color: var(--text-secondary);"><i class="ph ph-spinner spinner"></i> Memuat berkas cadangan...</td></tr>';
        const res = await fetch('api.php?action=get_backups');
        const json = await res.json();
        if (json.status === 'success' && json.data) {
            const d = json.data;
            if (statBackupFiles) statBackupFiles.textContent = `${d.total_files} Berkas`;
            if (statBackupSize) statBackupSize.textContent = d.total_size;
            if (statBackupLast) statBackupLast.textContent = d.last_backup !== '-' ? d.last_backup : 'Belum Ada';
            if (backupLogConsole) backupLogConsole.textContent = d.log || 'Belum ada catatan log aktivitas.';

            if (!d.files || d.files.length === 0) {
                backupTableBody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 2rem; color: var(--text-secondary);">Belum ada berkas cadangan di direktori backups. Silakan klik "Cadangkan Sekarang".</td></tr>';
                return;
            }

            backupTableBody.innerHTML = '';
            d.files.forEach((file, index) => {
                const tr = document.createElement('tr');
                const badgeClass = file.age_days < d.retention_days ? 'badge-success' : 'badge-danger';
                tr.innerHTML = `
                    <td><strong>${index + 1}</strong></td>
                    <td>
                        <div style="display: flex; align-items: center; gap: 0.5rem;">
                            <i class="ph ph-file-zip" style="color: #818cf8; font-size: 1.25rem;"></i>
                            <strong>${file.filename}</strong>
                        </div>
                    </td>
                    <td style="text-align: right;"><span class="badge badge-info">${file.size_formatted}</span></td>
                    <td>${file.created_at}</td>
                    <td>${file.age_days} hari lalu</td>
                    <td><span class="badge ${badgeClass}">${file.retention_status}</span></td>
                    <td style="text-align: center; white-space: nowrap;">
                        <a href="api.php?action=download_backup&file=${encodeURIComponent(file.filename)}" class="btn btn-secondary btn-sm" title="Unduh Arsip Cadangan" download style="margin-right: 4px;">
                            <i class="ph ph-download-simple"></i> Unduh
                        </a>
                        <button type="button" class="btn btn-danger btn-sm btn-open-restore" data-file="${file.filename}" title="Pulihkan Database dari Berkas Ini" style="background: rgba(239,68,68,0.15); color: #f87171; border: 1px solid rgba(239,68,68,0.35);">
                            <i class="ph ph-arrow-counter-clockwise"></i> Pulihkan
                        </button>
                    </td>
                `;
                backupTableBody.appendChild(tr);
            });
        }
    } catch (e) {
        console.error('Gagal memuat berkas backup:', e);
        if (backupTableBody) {
            backupTableBody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 2rem; color: #ef4444;">Gagal memuat data cadangan: ${e.message}</td></tr>`;
        }
    }
}

let currentBackupInterval = 'nightly';
let isRunningAutoBackup = false;

function startNightlyBackupCountdown() {
    if (backupCountdownInterval) clearInterval(backupCountdownInterval);

    const descEl = document.getElementById('backup-countdown-detail');
    const badgeEl = document.getElementById('backup-schedule-badge');

    function getNextTarget() {
        const now = new Date();
        if (currentBackupInterval === '10min') {
            const target = new Date(now);
            const remainder = target.getMinutes() % 10;
            target.setMinutes(target.getMinutes() + (10 - remainder));
            target.setSeconds(0, 0);
            return target;
        } else if (currentBackupInterval === '1hour') {
            const target = new Date(now);
            target.setHours(target.getHours() + 1);
            target.setMinutes(0, 0, 0);
            return target;
        } else {
            // Nightly 23:00 WIB
            const target = new Date(now);
            target.setHours(23, 0, 0, 0);
            if (now.getTime() >= target.getTime()) {
                target.setDate(target.getDate() + 1);
            }
            return target;
        }
    }

    let target = getNextTarget();

    if (descEl) {
        if (currentBackupInterval === '10min') {
            descEl.textContent = 'Mode Uji Coba: Pencadangan otomatis berjalan setiap kelipatan 10 menit.';
            if (badgeEl) badgeEl.innerHTML = '<i class="ph ph-lightning"></i> UJI COBA: TIAP 10 MENIT';
        } else if (currentBackupInterval === '1hour') {
            descEl.textContent = 'Mode Berkala: Pencadangan otomatis berjalan setiap 1 jam tepat.';
            if (badgeEl) badgeEl.innerHTML = '<i class="ph ph-clock"></i> AKTIF: TIAP 1 JAM';
        } else {
            descEl.textContent = 'Setiap hari pukul 23:00 WIB (Kompresi Gzip & Retensi Otomatis 14 Hari).';
            if (badgeEl) badgeEl.innerHTML = '<i class="ph ph-calendar-check"></i> AKTIF: TIAP MALAM 23:00 WIB';
        }
    }

    function update() {
        const now = new Date().getTime();
        const diff = target.getTime() - now;

        if (diff <= 0) {
            if (backupCountdownTimer) backupCountdownTimer.textContent = '00:00:00 (Jatuh Tempo)';
            
            // Jika mode uji coba 10 menit dan belum berjalan, picu otomatis
            if (currentBackupInterval === '10min' && !isRunningAutoBackup) {
                triggerAutoBackup();
            }
            
            // Re-arm target ke interval berikutnya
            target = getNextTarget();
            return;
        }

        const hours = Math.floor(diff / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((diff % (1000 * 60)) / 1000);

        const timeStr = `${String(hours).padStart(2, '0')}j ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}d`;
        if (backupCountdownTimer) backupCountdownTimer.textContent = timeStr;
    }

    update();
    backupCountdownInterval = setInterval(update, 1000);
}

async function triggerAutoBackup() {
    isRunningAutoBackup = true;
    try {
        if (btnRunBackupNow) {
            btnRunBackupNow.disabled = true;
            btnRunBackupNow.classList.add('btn-loading');
            btnRunBackupNow.innerHTML = '<i class="ph ph-spinner spinner"></i> Otomatis Mencadangkan...';
        }
        const res = await fetch('api.php?action=run_backup');
        const json = await res.json();
        if (json.status === 'success') {
            loadBackupData();
        }
    } catch (e) {
        console.error('Auto backup error:', e);
    } finally {
        isRunningAutoBackup = false;
        if (btnRunBackupNow) {
            btnRunBackupNow.disabled = false;
            btnRunBackupNow.classList.remove('btn-loading');
            btnRunBackupNow.innerHTML = '<i class="ph ph-play"></i> Cadangkan Sekarang';
        }
    }
}

// Event Listeners untuk Chip Interval Backup
const backupPresetChips = document.querySelectorAll('.backup-preset-chip');
backupPresetChips.forEach(chip => {
    chip.addEventListener('click', (e) => {
        backupPresetChips.forEach(c => c.classList.remove('active'));
        e.currentTarget.classList.add('active');
        currentBackupInterval = e.currentTarget.getAttribute('data-interval') || 'nightly';
        startNightlyBackupCountdown();
    });
});

if (btnRunBackupNow) {
    btnRunBackupNow.addEventListener('click', async () => {
        if (!confirm('Jalankan proses pencadangan database "simpadu" sekarang?\n\nProses mysqldump dan kompresi gzip akan berjalan di latar belakang server secara non-blocking.')) {
            return;
        }

        btnRunBackupNow.disabled = true;
        btnRunBackupNow.classList.add('btn-loading');
        btnRunBackupNow.innerHTML = '<i class="ph ph-spinner spinner"></i> Memulai Cadangan...';

        try {
            const res = await fetch('api.php?action=run_backup');
            const json = await res.json();
            if (json.status === 'success') {
                checkAndRenderBackupStatus();
                startBackupTabAutoPoller();
            } else {
                alert('Gagal: ' + (json.message || 'Terjadi kesalahan saat mencadangkan database.'));
            }
        } catch (e) {
            alert('Gagal menghubungi server: ' + e.message);
        } finally {
            btnRunBackupNow.disabled = false;
            btnRunBackupNow.classList.remove('btn-loading');
            btnRunBackupNow.innerHTML = '<i class="ph ph-play"></i> Cadangkan Sekarang';
        }
    });
}

if (btnRefreshBackups) {
    btnRefreshBackups.addEventListener('click', () => {
        loadBackupData();
    });
}

// =========================================================================
// Restore Database Modal & Handlers
// =========================================================================

const modalRestore = document.getElementById('modal-restore');
const btnCloseRestoreModal = document.getElementById('btn-close-restore-modal');
const btnCancelRestore = document.getElementById('btn-cancel-restore');
const formRestoreDatabase = document.getElementById('form-restore-database');
const restoreFileDisplay = document.getElementById('restore-file-display');
const restoreFileName = document.getElementById('restore-file-name');
const restoreTargetDb = document.getElementById('restore-target-db');
const restoreSafetyBackup = document.getElementById('restore-safety-backup');
const restoreConfirmText = document.getElementById('restore-confirm-text');
const btnSubmitRestore = document.getElementById('btn-submit-restore');

const restoreProgressContainer = document.getElementById('restore-progress-container');
const restoreResultContainer = document.getElementById('restore-result-container');
const restoreProgressBar = document.getElementById('restore-progress-bar');
const restorePercentText = document.getElementById('restore-percent-text');
const restoreLiveTimer = document.getElementById('restore-live-timer');
const restoreLogTicker = document.getElementById('restore-log-ticker');
const btnCloseRestoreSuccess = document.getElementById('btn-close-restore-success');

let restoreTimerInterval = null;
let restoreProgressInterval = null;

function setRestoreStepUI(stepNum, status, badgeText) {
    const row = document.getElementById(`restore-step-${stepNum}`);
    if (!row) return;
    const icon = row.querySelector('.restore-step-icon');
    const badge = row.querySelector('.restore-step-badge');

    row.className = 'restore-step-row';
    if (status === 'RUNNING') {
        row.classList.add('active');
        if (icon) icon.className = 'ph ph-spinner spinner restore-step-icon';
        if (badge) {
            badge.className = 'badge badge-warning restore-step-badge';
            badge.textContent = badgeText || 'Memproses...';
        }
    } else if (status === 'DONE') {
        row.classList.add('done');
        if (icon) icon.className = 'ph ph-check-circle restore-step-icon';
        if (badge) {
            badge.className = 'badge badge-success restore-step-badge';
            badge.textContent = badgeText || 'Selesai';
        }
    } else {
        if (icon) icon.className = 'ph ph-circle-dashed restore-step-icon';
        if (badge) {
            badge.className = 'badge badge-secondary restore-step-badge';
            badge.textContent = badgeText || 'Menunggu';
        }
    }
}

function openRestoreModal(filename) {
    if (!modalRestore) return;
    if (restoreFileDisplay) restoreFileDisplay.textContent = filename;
    if (restoreFileName) restoreFileName.value = filename;
    if (restoreTargetDb) restoreTargetDb.value = 'simpadu';
    if (restoreSafetyBackup) restoreSafetyBackup.checked = true;
    if (restoreConfirmText) restoreConfirmText.value = '';

    // Tampilkan form awal, sembunyikan progress & result
    if (formRestoreDatabase) formRestoreDatabase.style.display = 'block';
    if (restoreProgressContainer) restoreProgressContainer.style.display = 'none';
    if (restoreResultContainer) restoreResultContainer.style.display = 'none';

    // Reset step states
    for (let i = 1; i <= 4; i++) {
        setRestoreStepUI(i, 'WAITING', 'Menunggu');
    }
    if (restoreProgressBar) restoreProgressBar.style.width = '0%';
    if (restorePercentText) restorePercentText.textContent = '0%';
    if (restoreLiveTimer) restoreLiveTimer.innerHTML = '<i class="ph ph-timer"></i> 00:00';

    modalRestore.style.display = 'flex';
}

function closeRestoreModal() {
    if (restoreTimerInterval) clearInterval(restoreTimerInterval);
    if (restoreProgressInterval) clearInterval(restoreProgressInterval);
    if (modalRestore) modalRestore.style.display = 'none';
}

if (btnCloseRestoreModal) {
    btnCloseRestoreModal.addEventListener('click', closeRestoreModal);
}
if (btnCancelRestore) {
    btnCancelRestore.addEventListener('click', closeRestoreModal);
}
if (btnCloseRestoreSuccess) {
    btnCloseRestoreSuccess.addEventListener('click', () => {
        closeRestoreModal();
        loadBackupData();
    });
}

// Delegate klik tombol Pulihkan pada tabel cadangan
if (backupTableBody) {
    backupTableBody.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-open-restore');
        if (btn) {
            const filename = btn.getAttribute('data-file');
            if (filename) {
                openRestoreModal(filename);
            }
        }
    });
}

// Form Submit Restore Handler
if (formRestoreDatabase) {
    formRestoreDatabase.addEventListener('submit', async (e) => {
        e.preventDefault();
        const file = restoreFileName ? restoreFileName.value : '';
        const targetDb = (restoreTargetDb ? restoreTargetDb.value : 'simpadu').trim();
        const safetyBackup = restoreSafetyBackup ? restoreSafetyBackup.checked : true;
        const confirmText = (restoreConfirmText ? restoreConfirmText.value : '').trim();

        if (confirmText.toUpperCase() !== 'RESTORE') {
            alert('Konfirmasi tidak valid! Anda harus mengetik kata RESTORE persis.');
            if (restoreConfirmText) restoreConfirmText.focus();
            return;
        }

        const msgConfirm = `APAKAH ANDA YAKIN INGIN MEMULIHKAN DATABASE?\n\n` +
            `• Berkas Sumber: ${file}\n` +
            `• Target Database: ${targetDb}\n` +
            `• Safety Snapshot: ${safetyBackup ? 'Ya (Direkomendasikan)' : 'Tidak'}\n\n` +
            `Semua data pada database '${targetDb}' akan digantikan dengan data dari arsip tersebut.`;

        if (!confirm(msgConfirm)) {
            return;
        }

        // Tampilkan layar progress animasi
        if (formRestoreDatabase) formRestoreDatabase.style.display = 'none';
        if (restoreProgressContainer) restoreProgressContainer.style.display = 'flex';
        if (restoreResultContainer) restoreResultContainer.style.display = 'none';

        // Start Stopwatch
        let elapsedSeconds = 0;
        if (restoreLiveTimer) restoreLiveTimer.innerHTML = '<i class="ph ph-timer"></i> 00:00';
        restoreTimerInterval = setInterval(() => {
            elapsedSeconds++;
            const m = String(Math.floor(elapsedSeconds / 60)).padStart(2, '0');
            const s = String(elapsedSeconds % 60).padStart(2, '0');
            if (restoreLiveTimer) {
                restoreLiveTimer.innerHTML = `<i class="ph ph-timer"></i> ${m}:${s}`;
            }
        }, 1000);

        // Simulated Stage Progression for smooth UX
        let currentProgress = 5;
        if (restoreProgressBar) restoreProgressBar.style.width = '5%';
        if (restorePercentText) restorePercentText.textContent = '5%';
        setRestoreStepUI(1, safetyBackup ? 'RUNNING' : 'DONE', safetyBackup ? 'Membuat Snapshot...' : 'Dilewati');

        if (restoreLogTicker) {
            restoreLogTicker.textContent = `[${new Date().toLocaleTimeString('id-ID')}] Memulai proses restore untuk berkas ${file} ke database ${targetDb}...`;
        }

        // Timer to step through stages
        let stepProgressTimer = setTimeout(() => {
            if (safetyBackup) setRestoreStepUI(1, 'DONE', 'Snapshot Siap');
            setRestoreStepUI(2, 'RUNNING', 'Mengekstrak GZIP...');
            currentProgress = 35;
            if (restoreProgressBar) restoreProgressBar.style.width = '35%';
            if (restorePercentText) restorePercentText.textContent = '35%';
            if (restoreLogTicker) {
                restoreLogTicker.textContent += `\n[${new Date().toLocaleTimeString('id-ID')}] Dekompresi stream berkas GZIP (.sql.gz) sedang berlangsung...`;
                restoreLogTicker.scrollTop = restoreLogTicker.scrollHeight;
            }

            stepProgressTimer = setTimeout(() => {
                setRestoreStepUI(2, 'DONE', 'Dekompresi Selesai');
                setRestoreStepUI(3, 'RUNNING', 'Mengimpor Data...');
                currentProgress = 65;
                if (restoreProgressBar) restoreProgressBar.style.width = '65%';
                if (restorePercentText) restorePercentText.textContent = '65%';
                if (restoreLogTicker) {
                    restoreLogTicker.textContent += `\n[${new Date().toLocaleTimeString('id-ID')}] Mengimpor skema tabel, data record, routines & triggers ke MySQL...`;
                    restoreLogTicker.scrollTop = restoreLogTicker.scrollHeight;
                }

                stepProgressTimer = setTimeout(() => {
                    setRestoreStepUI(3, 'RUNNING', 'Hampir Selesai...');
                    currentProgress = 88;
                    if (restoreProgressBar) restoreProgressBar.style.width = '88%';
                    if (restorePercentText) restorePercentText.textContent = '88%';
                }, 20000);
            }, 12000);
        }, 8000);

        // Real-time live status & active query polling
        let lastKnownQuery = '';
        restoreProgressInterval = setInterval(async () => {
            try {
                const res = await fetch('api.php?action=get_restore_status');
                const json = await res.json();
                if (json.status === 'success') {
                    if (json.active_table) {
                        setRestoreStepUI(3, 'RUNNING', `Tabel: ${json.active_table}`);
                    }
                    if (json.query_snippet && json.query_snippet !== lastKnownQuery) {
                        lastKnownQuery = json.query_snippet;
                        if (restoreLogTicker) {
                            const timeStr = json.timestamp || new Date().toLocaleTimeString('id-ID');
                            restoreLogTicker.textContent += `\n[${timeStr}] ${json.query_snippet}`;
                            restoreLogTicker.scrollTop = restoreLogTicker.scrollHeight;
                        }
                    }
                }
            } catch (e) {
                // ignore background poll error
            }
        }, 1500);

        // Proteksi reload tidak sengaja saat proses restore berjalan
        const onBeforeUnloadHandler = (e) => {
            e.preventDefault();
            e.returnValue = 'Proses pemulihan database sedang berjalan di server. Jangan muat ulang halaman.';
            return e.returnValue;
        };
        window.addEventListener('beforeunload', onBeforeUnloadHandler);

        try {
            const res = await fetch('api.php?action=run_restore', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    file: file,
                    target_db: targetDb,
                    safety_backup: safetyBackup,
                    confirm_text: confirmText
                })
            });

            window.removeEventListener('beforeunload', onBeforeUnloadHandler);
            clearTimeout(stepProgressTimer);
            if (restoreTimerInterval) clearInterval(restoreTimerInterval);
            if (restoreProgressInterval) clearInterval(restoreProgressInterval);

            const json = await res.json();
            if (json.status === 'success') {
                for (let i = 1; i <= 4; i++) {
                    setRestoreStepUI(i, 'DONE', 'Selesai');
                }
                if (restoreProgressBar) restoreProgressBar.style.width = '100%';
                if (restorePercentText) restorePercentText.textContent = '100%';

                const finalTime = `${Math.floor(elapsedSeconds / 60)}m ${elapsedSeconds % 60}s`;

                setTimeout(() => {
                    if (restoreProgressContainer) restoreProgressContainer.style.display = 'none';
                    if (restoreResultContainer) restoreResultContainer.style.display = 'block';

                    const resTitle = document.getElementById('restore-result-title');
                    const resMsg = document.getElementById('restore-result-message');
                    if (resTitle) resTitle.textContent = `Pemulihan Selesai Sukses (${finalTime})`;
                    if (resMsg) {
                        resMsg.innerHTML = `Database <strong>'${targetDb}'</strong> berhasil dipulihkan secara penuh dari berkas <code>${file}</code>.<br><small style="color: #94a3b8; display: inline-block; margin-top: 0.5rem;">Total durasi: ${elapsedSeconds} detik. Snapshot pengaman tersimpan di direktori backups.</small>`;
                    }
                }, 800);
            } else {
                alert('GAGAL: ' + (json.message || 'Terjadi kesalahan saat memulihkan database.') + (json.error_detail ? '\n\nDetail: ' + json.error_detail : ''));
                if (formRestoreDatabase) formRestoreDatabase.style.display = 'block';
                if (restoreProgressContainer) restoreProgressContainer.style.display = 'none';
            }
        } catch (err) {
            window.removeEventListener('beforeunload', onBeforeUnloadHandler);
            clearTimeout(stepProgressTimer);
            if (restoreTimerInterval) clearInterval(restoreTimerInterval);
            if (restoreProgressInterval) clearInterval(restoreProgressInterval);
            alert('Kesalahan jaringan / timeout: ' + err.message);
            if (formRestoreDatabase) formRestoreDatabase.style.display = 'block';
            if (restoreProgressContainer) restoreProgressContainer.style.display = 'none';
        }
    });
}

// ====================================================================
// MASTER PIPELINE 6-TAHAP LOGIC & LIVE ANIMATION TRACKER
// ====================================================================
const btnRunMasterPipeline = document.getElementById('btn-run-master-pipeline');
const btnRefreshPipelineLogs = document.getElementById('btn-refresh-pipeline-logs');
const pipelineConsoleOutput = document.getElementById('pipeline-console-output');
const pipelineHistoryTbody = document.getElementById('pipeline-history-tbody');
const pipelineBatchIdBadge = document.getElementById('pipeline-batch-id-badge');
const pipelineLiveIndicator = document.getElementById('pipeline-live-indicator');
const pipelineStatusBadge = document.getElementById('pipeline-status-badge');

let pipelineLiveTimerInterval = null;
let pipelinePollerInterval = null;
let pipelineStartTimestamp = null;

const stepNamesDef = [
    'Tahap 0: Set Mode Maintenance (OFFLINE = 0)',
    'Tahap 1: Pencadangan Database (Backup DB simpadu)',
    'Tahap 2: Transaksi Beli YKK',
    'Tahap 3: Transaksi Tutup Tagihan',
    'Tahap 4: Transaksi Transfer Tagihan ke PPOB',
    'Tahap 5: Set Mode Online Kembali (OFFLINE = 1)'
];

function updatePipelineProgressUI(stepIndex, status, customTitle, isDone = false) {
    const fill = document.getElementById('pipeline-progress-fill');
    const percentEl = document.getElementById('pipeline-progress-percent');
    const titleEl = document.getElementById('pipeline-progress-phase-title');
    const radar = document.getElementById('pipeline-radar-pulse');

    if (!fill || !percentEl || !titleEl) return;

    let pct = 0;
    if (isDone) {
        pct = 100;
    } else if (stepIndex >= 0) {
        // Step 0 -> 16%, Step 1 -> 33%, Step 2 -> 50%, Step 3 -> 66%, Step 4 -> 83%, Step 5 -> 95%
        const stepPct = [16, 33, 50, 66, 83, 95];
        pct = stepPct[stepIndex] || Math.round(((stepIndex + 1) / 6) * 100);
        if (status === 'RUNNING') {
            pct = Math.max(8, pct - 8);
        }
    }

    fill.style.width = `${pct}%`;
    percentEl.textContent = `${pct}%`;

    if (customTitle) {
        titleEl.textContent = customTitle;
    } else if (stepIndex >= 0 && stepNamesDef[stepIndex]) {
        titleEl.textContent = (status === 'RUNNING' ? 'Sedang Memproses ' : 'Selesai ') + stepNamesDef[stepIndex];
    } else if (isDone) {
        titleEl.textContent = 'Semua 6 Tahapan Selesai dengan Sukses!';
    } else {
        titleEl.textContent = 'Standby: Siap Dijalankan';
    }

    if (radar) {
        radar.className = 'radar-pulse-dot';
        if (status === 'RUNNING') radar.classList.add('running');
        else if (status === 'SUCCESS' || isDone) radar.classList.add('success');
        else if (status === 'FAILED') radar.classList.add('failed');
    }

    // Subtext highlighting
    for (let i = 0; i <= 5; i++) {
        const sub = document.getElementById(`subtext-step-${i}`);
        if (!sub) continue;
        sub.classList.remove('active', 'done');
        if (i < stepIndex || isDone) {
            sub.classList.add('done');
        } else if (i === stepIndex) {
            if (status === 'RUNNING') sub.classList.add('active');
            else if (status === 'SUCCESS') sub.classList.add('done');
        }
    }
}

function startPipelineStopwatch() {
    stopPipelineStopwatch();
    pipelineStartTimestamp = Date.now();
    const timerBadge = document.getElementById('pipeline-live-timer');
    pipelineLiveTimerInterval = setInterval(() => {
        if (!timerBadge) return;
        const elapsedSec = Math.floor((Date.now() - pipelineStartTimestamp) / 1000);
        const m = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
        const s = String(elapsedSec % 60).padStart(2, '0');
        timerBadge.innerHTML = `<i class="ph ph-timer"></i> ${m}:${s}`;
    }, 1000);
}

function stopPipelineStopwatch(finalText = null) {
    if (pipelineLiveTimerInterval) {
        clearInterval(pipelineLiveTimerInterval);
        pipelineLiveTimerInterval = null;
    }
    const timerBadge = document.getElementById('pipeline-live-timer');
    if (timerBadge && finalText) {
        timerBadge.innerHTML = `<i class="ph ph-check-circle"></i> ${finalText}`;
    }
}

function updateStepCardUI(stepNum, status, metaText) {
    const card = document.getElementById(`step-card-${stepNum}`);
    const badge = document.getElementById(`step-badge-${stepNum}`);
    const meta = document.getElementById(`step-meta-${stepNum}`);
    if (!card || !badge) return;

    card.classList.remove('active', 'success', 'failed');
    if (status === 'RUNNING') {
        card.classList.add('active');
        badge.innerHTML = '<i class="ph ph-spinner spinner"></i> PROSES';
    } else if (status === 'SUCCESS') {
        card.classList.add('success');
        badge.innerHTML = '<i class="ph ph-check"></i> SUKSES';
    } else if (status === 'FAILED') {
        card.classList.add('failed');
        badge.innerHTML = '<i class="ph ph-x"></i> GAGAL';
    } else {
        badge.textContent = 'STANDBY';
    }

    if (meta && metaText) {
        meta.textContent = metaText;
    }

    // Update connector
    const connectors = document.querySelectorAll('.pipeline-stepper-grid .step-connector');
    if (connectors && connectors.length > stepNum) {
        const conn = connectors[stepNum];
        if (conn) {
            conn.classList.remove('active', 'done');
            if (status === 'SUCCESS') conn.classList.add('done');
            else if (status === 'RUNNING') conn.classList.add('active');
        }
    }
}

function resetAllStepCards() {
    for (let i = 0; i <= 5; i++) {
        updateStepCardUI(i, 'STANDBY', '-');
    }
    const connectors = document.querySelectorAll('.pipeline-stepper-grid .step-connector');
    if (connectors) {
        connectors.forEach(c => c.classList.remove('active', 'done'));
    }
    if (pipelineBatchIdBadge) pipelineBatchIdBadge.textContent = 'Batch: Siap Dijalankan';
    if (pipelineLiveIndicator) {
        pipelineLiveIndicator.textContent = 'IDLE';
        pipelineLiveIndicator.className = 'badge badge-secondary';
    }
    updatePipelineProgressUI(-1, 'STANDBY', 'Standby: Menunggu Eksekusi', false);
    stopPipelineStopwatch();
    const timerBadge = document.getElementById('pipeline-live-timer');
    if (timerBadge) timerBadge.innerHTML = '<i class="ph ph-timer"></i> 00:00';
}

let pipelineTabAutoPoller = null;

function startPipelineTabAutoPoller() {
    if (pipelineTabAutoPoller) clearInterval(pipelineTabAutoPoller);
    pipelineTabAutoPoller = setInterval(() => {
        loadPipelineLogs();
    }, 2000);
}

function stopPipelineTabAutoPoller() {
    if (pipelineTabAutoPoller) {
        clearInterval(pipelineTabAutoPoller);
        pipelineTabAutoPoller = null;
    }
}

async function loadPipelineLogs() {
    if (!pipelineHistoryTbody) return;

    try {
        const res = await fetch('api.php?action=get_pipeline_logs&limit=50');
        const json = await res.json();

        if (json.status === 'success' && json.batches && json.batches.length > 0) {
            let html = '';
            json.batches.forEach(b => {
                const isSuccess = b.status === 'SUCCESS';
                const badgeClass = isSuccess ? 'badge-success' : (b.status === 'RUNNING' ? 'badge-warning' : 'badge-danger');
                const badgeIcon = isSuccess ? 'ph-check-circle' : (b.status === 'RUNNING' ? 'ph-spinner spinner' : 'ph-x-circle');
                const stepCount = b.steps ? b.steps.length : 0;

                html += `
                    <tr>
                        <td><code style="color: #a5b4fc; font-size: 0.75rem;">${b.batch_id}</code></td>
                        <td><strong>${b.periode}</strong></td>
                        <td>${b.waktu_mulai}</td>
                        <td>
                            <span class="badge ${badgeClass}">
                                <i class="ph ${badgeIcon}"></i> ${b.status} (${stepCount}/6 Tahap)
                            </span>
                        </td>
                    </tr>
                `;
            });
            pipelineHistoryTbody.innerHTML = html;

            // Render batch terakhir pada stepper & progress bar
            const latestBatch = json.batches[0];
            if (latestBatch && latestBatch.steps) {
                if (pipelineBatchIdBadge) {
                    pipelineBatchIdBadge.textContent = `Batch: ${latestBatch.batch_id} (${latestBatch.periode})`;
                }
                
                // Reset semua kartu tahap ke STANDBY agar tidak membawa sisa status dari batch lama
                for (let i = 0; i <= 5; i++) {
                    updateStepCardUI(i, 'STANDBY', '');
                }

                let highestStep = -1;
                let hasRunning = false;
                let hasFailed = false;
                let step1IsRunning = false;

                latestBatch.steps.forEach(st => {
                    const stepNum = parseInt(st.step, 10);
                    if (stepNum >= 0 && stepNum <= 5) {
                        const dur = st.durasi_detik ? `${st.durasi_detik}s` : '0s';
                        const timeStr = st.waktu_mulai ? st.waktu_mulai.split(' ')[1] : '';
                        updateStepCardUI(stepNum, st.status, `${dur} | ${timeStr}`);
                        if (stepNum > highestStep) highestStep = stepNum;
                        if (st.status === 'RUNNING') {
                            hasRunning = true;
                            if (stepNum === 1) step1IsRunning = true;
                        }
                        if (st.status === 'FAILED') hasFailed = true;
                    }
                });

                if (latestBatch.status === 'SUCCESS' && latestBatch.steps.length >= 6) {
                    updatePipelineProgressUI(5, 'SUCCESS', 'Master Pipeline Terakhir Berhasil Selesai Penuh (6/6 Tahap)', true);
                    if (pipelineLiveIndicator) {
                        pipelineLiveIndicator.textContent = 'COMPLETED';
                        pipelineLiveIndicator.className = 'badge badge-success';
                    }
                    if (pipelineStatusBadge) {
                        pipelineStatusBadge.innerHTML = '<i class="ph ph-check-circle"></i> SUKSES PENUH';
                        pipelineStatusBadge.className = 'badge badge-success';
                    }
                } else if (hasRunning || latestBatch.status === 'RUNNING') {
                    if (pipelineLiveIndicator) {
                        pipelineLiveIndicator.textContent = 'RUNNING';
                        pipelineLiveIndicator.className = 'badge badge-warning';
                    }
                    if (pipelineStatusBadge) {
                        pipelineStatusBadge.innerHTML = '<i class="ph ph-spinner spinner"></i> SEDANG BERJALAN...';
                        pipelineStatusBadge.className = 'badge badge-warning';
                    }
                    updatePipelineProgressUI(highestStep, 'RUNNING', `Sedang Berjalan: ${stepNamesDef[highestStep] || 'Tahap ' + highestStep}`);
                } else if (hasFailed || latestBatch.status === 'FAILED') {
                    if (pipelineLiveIndicator) {
                        pipelineLiveIndicator.textContent = 'FAILED';
                        pipelineLiveIndicator.className = 'badge badge-danger';
                    }
                    if (pipelineStatusBadge) {
                        pipelineStatusBadge.innerHTML = '<i class="ph ph-warning"></i> GAGAL';
                        pipelineStatusBadge.className = 'badge badge-danger';
                    }
                    updatePipelineProgressUI(highestStep, 'FAILED', `Gagal pada ${stepNamesDef[highestStep] || 'Tahap ' + highestStep}`);
                }

                // Tampilkan Live Stream Byte Counter HANYA jika Tahap 1 sedang berstatus RUNNING
                if (step1IsRunning && json.active_backup && json.active_backup.is_writing) {
                    const ab = json.active_backup;
                    const cardMeta1 = document.getElementById('step-meta-1');
                    if (cardMeta1) {
                        cardMeta1.innerHTML = `<span style="color: #38bdf8; font-weight: 600;"><i class="ph ph-arrows-clockwise spinner"></i> ${ab.display_text}</span>`;
                    }
                    const phaseTitle = document.getElementById('pipeline-progress-phase-title');
                    if (phaseTitle && highestStep === 1) {
                        phaseTitle.textContent = `Tahap 1: Pencadangan Database (${ab.display_text})`;
                    }
                }

                // Update Live SQL Query Ticker
                const pipelineQueryTicker = document.getElementById('pipeline-query-ticker');
                const pipelineTableBadge = document.getElementById('pipeline-active-table-badge');
                if (pipelineTableBadge && json.active_table) {
                    pipelineTableBadge.textContent = `Tabel: ${json.active_table}`;
                }
                if (pipelineQueryTicker) {
                    if (json.query_snippet) {
                        pipelineQueryTicker.textContent = `[${new Date().toLocaleTimeString('id-ID')}] ${json.query_snippet}`;
                    } else if (latestBatch.status === 'SUCCESS') {
                        pipelineQueryTicker.textContent = 'Semua operasi SQL 6 tahap pipeline telah selesai dengan sukses.';
                        if (pipelineTableBadge) pipelineTableBadge.textContent = 'Selesai';
                    }
                }
            }
        } else {
            pipelineHistoryTbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-secondary); padding: 1.5rem;">Belum ada riwayat batch pipeline.</td></tr>';
        }
    } catch (e) {
        console.error('Gagal memuat log pipeline:', e);
    }
}

async function runMasterPipeline() {
    if (!confirm("PERINGATAN:\nAnda akan menjalankan MASTER PIPELINE (6 TAHAPAN BERURUTAN):\n\n1. Tahap 0: Set OFFLINE = '0'\n2. Tahap 1: Backup Database simpadu\n3. Tahap 2: Transaksi Beli YKK\n4. Tahap 3: Transaksi Tutup Tagihan\n5. Tahap 4: Transaksi Transfer PPOB\n6. Tahap 5: Set OFFLINE = '1'\n\nLanjutkan eksekusi penuh sekarang?")) {
        return;
    }

    if (!btnRunMasterPipeline) return;

    btnRunMasterPipeline.disabled = true;
    btnRunMasterPipeline.classList.add('btn-loading');
    btnRunMasterPipeline.innerHTML = '<i class="ph ph-spinner spinner"></i> Sedang Memproses Pipeline...';

    if (pipelineLiveIndicator) {
        pipelineLiveIndicator.textContent = 'RUNNING';
        pipelineLiveIndicator.className = 'badge badge-warning';
    }
    if (pipelineStatusBadge) {
        pipelineStatusBadge.innerHTML = '<i class="ph ph-spinner spinner"></i> MEMPROSES...';
        pipelineStatusBadge.className = 'badge badge-warning';
    }

    resetAllStepCards();
    startPipelineStopwatch();
    updateStepCardUI(0, 'RUNNING', 'Memulai...');
    updatePipelineProgressUI(0, 'RUNNING', 'Tahap 0: Set Mode Maintenance (OFFLINE = 0)...');
    pipelineConsoleOutput.textContent = `[${new Date().toLocaleTimeString('id-ID')}] Memulai eksekusi Master Pipeline 6-Tahapan...\n`;

    // Active live polling interval during execution
    let poller = setInterval(async () => {
        try {
            const res = await fetch('api.php?action=get_pipeline_logs&limit=5');
            const json = await res.json();
            if (json.status === 'success' && json.batches && json.batches.length > 0) {
                const cur = json.batches[0];
                if (cur && cur.steps) {
                    let highest = 0;
                    cur.steps.forEach(st => {
                        const stepNum = parseInt(st.step, 10);
                        if (stepNum >= 0 && stepNum <= 5) {
                            const dur = st.durasi_detik ? `${st.durasi_detik}s` : '0s';
                            const timeStr = st.waktu_mulai ? st.waktu_mulai.split(' ')[1] : '';
                            updateStepCardUI(stepNum, st.status, `${dur} | ${timeStr}`);
                            if (stepNum > highest) highest = stepNum;
                        }
                    });
                    const lastStep = cur.steps[cur.steps.length - 1];
                    if (lastStep) {
                        updatePipelineProgressUI(parseInt(lastStep.step, 10), lastStep.status, null);
                    }
                }

                // Update ticker during active execution
                const pipelineQueryTicker = document.getElementById('pipeline-query-ticker');
                const pipelineTableBadge = document.getElementById('pipeline-active-table-badge');
                if (pipelineTableBadge && json.active_table) {
                    pipelineTableBadge.textContent = `Tabel: ${json.active_table}`;
                }
                if (pipelineQueryTicker && json.query_snippet) {
                    pipelineQueryTicker.textContent = `[${new Date().toLocaleTimeString('id-ID')}] ${json.query_snippet}`;
                }
            }
        } catch (e) {
            // ignore silent polling errors
        }
    }, 1500);

    try {
        const res = await fetch('api.php?action=run_pipeline', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                executed_by: 'WEB_DASHBOARD',
                budget: maxBudget || 0,
                user_id: 1
            })
        });

        clearInterval(poller);
        const json = await res.json();

        if (json.data && json.data.logs) {
            pipelineConsoleOutput.textContent = json.data.logs.join('\n');
            pipelineConsoleOutput.scrollTop = pipelineConsoleOutput.scrollHeight;
        }

        if (json.status === 'success') {
            const data = json.data;
            if (pipelineBatchIdBadge) pipelineBatchIdBadge.textContent = `Batch: ${data.batch_id} (${data.periode})`;
            if (pipelineLiveIndicator) {
                pipelineLiveIndicator.textContent = 'COMPLETED';
                pipelineLiveIndicator.className = 'badge badge-success';
            }
            if (pipelineStatusBadge) {
                pipelineStatusBadge.innerHTML = '<i class="ph ph-check-circle"></i> SUKSES PENUH';
                pipelineStatusBadge.className = 'badge badge-success';
            }

            for (let i = 0; i <= 5; i++) {
                if (data.steps && data.steps[i]) {
                    updateStepCardUI(i, 'SUCCESS', data.steps[i].pesan || 'Selesai');
                }
            }

            stopPipelineStopwatch(`${data.durasi_total_detik}s`);
            updatePipelineProgressUI(5, 'SUCCESS', `Master Pipeline Selesai Sukses Penuh (${data.durasi_total_detik} detik)`, true);

            alert(`BERHASIL: Master Pipeline 6-Tahap Sukses Penuh!\n\nBatch ID: ${data.batch_id}\nTotal Durasi: ${data.durasi_total_detik} detik`);
            loadPipelineLogs();
            loadAutomationConfig();
        } else {
            clearInterval(poller);
            if (pipelineLiveIndicator) {
                pipelineLiveIndicator.textContent = 'FAILED';
                pipelineLiveIndicator.className = 'badge badge-danger';
            }
            if (pipelineStatusBadge) {
                pipelineStatusBadge.innerHTML = '<i class="ph ph-warning"></i> GAGAL';
                pipelineStatusBadge.className = 'badge badge-danger';
            }
            stopPipelineStopwatch('Gagal');
            updatePipelineProgressUI(0, 'FAILED', `Master Pipeline Gagal: ${json.message || json.error}`, false);
            alert(`GAGAL: Master Pipeline Terhenti!\n\nDetail: ${json.message || json.error}`);
            loadPipelineLogs();
        }
    } catch (err) {
        clearInterval(poller);
        stopPipelineStopwatch('Error');
        updatePipelineProgressUI(0, 'FAILED', 'Terjadi kesalahan jaringan/timeout', false);
        alert('Terjadi kesalahan koneksi atau eksekusi: ' + err.message);
        if (pipelineLiveIndicator) {
            pipelineLiveIndicator.textContent = 'ERROR';
            pipelineLiveIndicator.className = 'badge badge-danger';
        }
    } finally {
        clearInterval(poller);
        btnRunMasterPipeline.disabled = false;
        btnRunMasterPipeline.classList.remove('btn-loading');
        btnRunMasterPipeline.innerHTML = '<i class="ph ph-play"></i> Jalankan Master Pipeline Sekarang';
    }
}

if (btnRunMasterPipeline) {
    btnRunMasterPipeline.addEventListener('click', runMasterPipeline);
}
if (btnRefreshPipelineLogs) {
    btnRefreshPipelineLogs.addEventListener('click', loadPipelineLogs);
}

// Init
const urlParams = new URLSearchParams(window.location.search);
const paramTab = urlParams.get('tab');
const paramDate = urlParams.get('date');
const autoLoad = urlParams.get('autoload');

if (paramTab && (paramTab === 'beli' || paramTab === 'batal' || paramTab === 'dibeli' || paramTab === 'otomasi' || paramTab === 'pipeline' || paramTab === 'backup')) {
    switchTab(paramTab);
} else {
    switchTab('beli');
}

if (paramDate) {
    datePicker.value = paramDate;
    updatePeriodeUI();
}

const testLoading = urlParams.get('testloading');
if (testLoading === '1') {
    const progressBar = document.getElementById('table-progress-bar');
    if (progressBar) progressBar.style.display = 'block';
    tableBody.innerHTML = `
        <tr>
            <td colspan="10">
                <div class="loading-container">
                    <div class="loading-spinner-wrapper">
                        <div class="loading-ring"></div>
                        <div class="loading-ring-inner"></div>
                        <i class="ph ph-database"></i>
                    </div>
                    <div class="loading-title">Sedang Mengambil Data dari Database...</div>
                    <div class="loading-subtitle">Menyaring jutaan data rekening, pengecekan tunggakan, penertiban & realisasi untuk periode terpilih.</div>
                    <div class="loading-skeleton-bar"></div>
                </div>
            </td>
        </tr>
    `;
    btnLoadData.disabled = true;
    btnLoadData.classList.add('btn-loading');
    btnLoadData.innerHTML = '<i class="ph ph-spinner spinner"></i> Memuat Data...';
} else if (autoLoad === '1') {
    setTimeout(() => {
        fetchData(currentTab);
    }, 300);
}

