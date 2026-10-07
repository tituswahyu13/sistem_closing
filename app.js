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
const otomasiSection = document.getElementById('pipeline-section') || document.getElementById('otomasi-section');
const pipelineSection = document.getElementById('pipeline-section');
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
    
    // Update Active Class on Sidebar
    navItems.forEach(btn => btn.classList.remove('active'));
    const activeNav = document.querySelector(`[data-tab="${tabId}"]`);
    if (activeNav) activeNav.classList.add('active');
    
    // Always stop background pollers when leaving pipeline/backup/rekening tabs
    if (tabId !== 'pipeline' && tabId !== 'otomasi') {
        stopPipelineTabAutoPoller();
    }
    if (tabId !== 'backup') {
        stopBackupTabAutoPoller();
    }
    if (tabId !== 'closing_rekening') {
        stopRekeningTabAutoPoller();
    }

    const tableContainer = document.querySelector('.table-container');
    const pipelineSec = document.getElementById('pipeline-section');
    const backupSec = document.getElementById('backup-section');
    const closingRekeningSec = document.getElementById('closing-rekening-section');
    const auditSec = document.getElementById('audit-section');
    
    // Reset all major section visibility
    if (pipelineSec) pipelineSec.style.display = (tabId === 'pipeline' || tabId === 'otomasi') ? 'block' : 'none';
    if (backupSec) backupSec.style.display = (tabId === 'backup') ? 'block' : 'none';
    if (closingRekeningSec) closingRekeningSec.style.display = (tabId === 'closing_rekening') ? 'block' : 'none';
    if (auditSec) auditSec.style.display = (tabId === 'audit') ? 'block' : 'none';
    
    const isTableTab = (tabId === 'beli' || tabId === 'batal' || tabId === 'dibeli');
    if (tableContainer) tableContainer.style.display = isTableTab ? 'block' : 'none';
    if (statsGrid) statsGrid.style.display = isTableTab ? 'grid' : 'none';
    if (queryContainerPanel) queryContainerPanel.style.display = isTableTab ? 'block' : 'none';

    // Update Title and UI Elements per Tab
    if (tabId === 'beli') {
        pageTitle.textContent = 'Rencana Beli YKK';
        if (thAlasan) thAlasan.style.display = 'none';
        if (thTglBayar) thTglBayar.style.display = 'none';
        if (thDenda) thDenda.style.display = 'none';
        if (thKuota) thKuota.style.display = 'none';
        if (statCardAlasan) statCardAlasan.style.display = 'none';
        if (budgetPanel) budgetPanel.style.display = 'flex';
        if (maxBudget > 0 && currentData.length > 0) {
            if (statCardSisa) statCardSisa.style.display = 'flex';
            if (budgetProgressSection) budgetProgressSection.style.display = 'flex';
        }
        showEmptyState();
        updatePeriodeUI();
    } else if (tabId === 'batal') {
        pageTitle.textContent = 'Rencana Pembatalan YKK';
        if (thAlasan) thAlasan.style.display = 'table-cell';
        if (thTglBayar) thTglBayar.style.display = 'none';
        if (thDenda) thDenda.style.display = 'none';
        if (thKuota) thKuota.style.display = 'none';
        if (statCardAlasan) statCardAlasan.style.display = 'flex';
        if (statCardSisa) statCardSisa.style.display = 'none';
        if (budgetPanel) budgetPanel.style.display = 'none';
        showEmptyState();
        updatePeriodeUI();
    } else if (tabId === 'dibeli') {
        pageTitle.textContent = 'Data Rekening Dibeli YKK';
        if (thAlasan) thAlasan.style.display = 'none';
        if (thTglBayar) thTglBayar.style.display = 'table-cell';
        if (thDenda) thDenda.style.display = 'table-cell';
        if (thKuota) thKuota.style.display = 'none';
        if (statCardAlasan) statCardAlasan.style.display = 'none';
        if (statCardSisa) statCardSisa.style.display = 'none';
        if (budgetPanel) budgetPanel.style.display = 'none';
        showEmptyState();
        updatePeriodeUI();
    } else if (tabId === 'pipeline' || tabId === 'otomasi') {
        pageTitle.textContent = 'Closing Tagihan (Pipeline 6-Tahap Otomasi)';
        if (budgetPanel) budgetPanel.style.display = 'none';
        loadAutomationConfig();
        loadPipelineLogs();
        startPipelineTabAutoPoller();
    } else if (tabId === 'closing_rekening') {
        pageTitle.textContent = 'Closing Rekening (Pipeline 6-Tahap Otomasi)';
        if (budgetPanel) budgetPanel.style.display = 'none';
        
        // Update Rekening Info from active metrics
        const rekeningDbEl = document.getElementById('rekening-db-indicator');
        if (lastMetricsData && lastMetricsData.database && rekeningDbEl) {
            rekeningDbEl.textContent = `DB: ${lastMetricsData.database.label || lastMetricsData.database.host}`;
            rekeningDbEl.className = `badge ${lastMetricsData.database.env_type === 'Production' ? 'badge-prod' : 'badge-dev'}`;
        }
        loadRekeningConfig();
        loadRekeningPipelineLogs();
        startRekeningTabAutoPoller();
    } else if (tabId === 'audit') {
        pageTitle.textContent = 'Audit & Validasi Pra-Closing';
        if (budgetPanel) budgetPanel.style.display = 'none';
        loadAuditSummary();
        loadUncontrolledRekening(1);
        loadTagihanDuplicates();
        loadAngsuranDuplicates();
    } else if (tabId === 'backup') {
        pageTitle.textContent = 'Pencadangan Database Otomatis';
        if (budgetPanel) budgetPanel.style.display = 'none';
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
    if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
    }
    
    if (!targetDateStr || status === 'SUCCESS') {
        if (countdownTimer) countdownTimer.textContent = 'SELESAI';
        if (countdownDetail) countdownDetail.textContent = 'Transaksi periode ini sukses dieksekusi.';
        if (autoScheduleBadge) {
            autoScheduleBadge.className = 'badge badge-success';
            autoScheduleBadge.textContent = 'SUKSES DIEKSEKUSI';
        }
        return;
    }

    if (status === 'FAILED' || status === 'CANCELLED' || status === 'EXPIRED') {
        if (countdownTimer) countdownTimer.textContent = 'STANDBY';
        if (countdownDetail) countdownDetail.textContent = 'Antrean eksekusi selesai / kedaluwarsa. Silakan simpan jadwal baru.';
        if (autoScheduleBadge) {
            autoScheduleBadge.className = 'badge badge-secondary';
            autoScheduleBadge.textContent = 'STANDBY';
        }
        return;
    }

    const targetTime = new Date(targetDateStr.replace(' ', 'T')).getTime();

    function update() {
        const now = new Date().getTime();
        const diff = targetTime - now;

        if (diff <= 0) {
            // Cek jika diff sudah terlalu lampau (> 15 menit), jangan spam cron
            if (diff < -15 * 60 * 1000) {
                if (countdownTimer) countdownTimer.textContent = 'STANDBY';
                if (countdownDetail) countdownDetail.textContent = `Jadwal ${targetDateStr} telah terlewati. Silakan tentukan jadwal baru.`;
                if (autoScheduleBadge) {
                    autoScheduleBadge.className = 'badge badge-secondary';
                    autoScheduleBadge.textContent = 'KEDALUWARSA / STANDBY';
                }
                if (countdownInterval) {
                    clearInterval(countdownInterval);
                    countdownInterval = null;
                }
                return;
            }

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
            // Prioritaskan konfigurasi PENDING, jika tidak ada cari yang RUNNING, lalu targetPeriode
            let activeCfg = json.data.find(c => c.status === 'PENDING');
            if (!activeCfg) {
                activeCfg = json.data.find(c => c.status === 'RUNNING');
            }
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
            if (json.is_active) {
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

                const pctVal = json.percent !== undefined ? json.percent : 85;
                const pctStr = `${pctVal}%`;
                const tablesInfo = json.imported_tables ? `${json.imported_tables}/${json.total_tables || 89} Tabel` : '';
                const rowsInfo = json.rows_formatted || tablesInfo;

                if (phaseTitle) phaseTitle.innerHTML = `<span class="pipeline-radar-pulse" style="background: #ef4444; box-shadow: 0 0 10px #ef4444;"></span> Pemulihan Database: <span style="color: #fff; font-family: monospace;">${json.source_file || 'simpadu'}</span> <small style="color: #fca5a5; font-weight: normal;">(${rowsInfo ? rowsInfo + ' - ' : ''}${pctStr})</small>`;
                
                // Step 1: Safety Snapshot
                if (json.has_safety_snapshot) {
                    updatePageRestoreStepUI(1, 'SUCCESS', 'Snapshot Siap');
                } else {
                    updatePageRestoreStepUI(1, 'RUNNING', 'Snapshot...');
                }

                // Step 2: Dekompresi
                if (json.has_safety_snapshot && (json.active_table || pctVal > 25)) {
                    updatePageRestoreStepUI(2, 'SUCCESS', 'Dekompresi Selesai');
                } else if (json.has_safety_snapshot) {
                    updatePageRestoreStepUI(2, 'RUNNING', 'Mengekstrak...');
                } else {
                    updatePageRestoreStepUI(2, 'STANDBY', 'Menunggu');
                }

                // Step 3: Impor MySQL
                if (json.has_safety_snapshot && (json.active_table || json.imported_tables > 0 || json.imported_rows > 0)) {
                    updatePageRestoreStepUI(3, 'RUNNING', rowsInfo || `Tabel: ${json.active_table}`);
                    const desc3 = document.getElementById('page-restore-desc-3');
                    if (desc3) desc3.innerHTML = json.active_table ? `Mengisi tabel <code>${json.active_table}</code> (${rowsInfo})` : `Mengimpor struktur & data (${rowsInfo})`;
                } else if (!json.has_safety_snapshot) {
                    updatePageRestoreStepUI(3, 'STANDBY', 'Menunggu');
                    const desc3 = document.getElementById('page-restore-desc-3');
                    if (desc3) desc3.textContent = 'Injeksi skema, tabel, rutin & data.';
                } else {
                    updatePageRestoreStepUI(3, 'RUNNING', 'Memproses...');
                }

                // Step 4: Finalisasi
                if (pctVal >= 100 || json.is_finished) {
                    updatePageRestoreStepUI(4, 'SUCCESS', 'Selesai');
                } else {
                    updatePageRestoreStepUI(4, 'STANDBY', 'Menunggu');
                }

                if (tableBadge) {
                    tableBadge.className = 'badge badge-info';
                    tableBadge.textContent = json.active_table ? `Tabel: ${json.active_table} (${rowsInfo})` : (rowsInfo || 'Memproses...');
                }

                if (pctEl) { pctEl.textContent = pctStr; pctEl.style.color = '#fca5a5'; }
                if (barEl) { barEl.style.width = pctStr; barEl.style.background = 'linear-gradient(90deg, #f97316, #ef4444, #ec4899)'; }

                if (tickerEl && json.query_snippet) {
                    tickerEl.textContent = `[${json.timestamp || ''}] ${json.query_snippet}`;
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
            if (json.is_active) {
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
        backupTableBody.innerHTML = '<tr><td colspan="8" style="text-align: center; padding: 2rem; color: var(--text-secondary);"><i class="ph ph-spinner spinner"></i> Memuat berkas cadangan...</td></tr>';
        const res = await fetch('api.php?action=get_backups');
        const json = await res.json();
        if (json.status === 'success' && json.data) {
            const d = json.data;
            if (statBackupFiles) statBackupFiles.textContent = `${d.total_files} Berkas`;
            if (statBackupSize) statBackupSize.textContent = d.total_size;
            if (statBackupLast) statBackupLast.textContent = d.last_backup !== '-' ? d.last_backup : 'Belum Ada';
            if (backupLogConsole) backupLogConsole.textContent = d.log || 'Belum ada catatan log aktivitas.';

            if (!d.files || d.files.length === 0) {
                backupTableBody.innerHTML = '<tr><td colspan="8" style="text-align: center; padding: 2rem; color: var(--text-secondary);">Belum ada berkas cadangan di direktori backups. Silakan klik "Cadangkan Sekarang".</td></tr>';
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
                    <td style="text-align: center;">
                        <span class="badge badge-primary" style="font-family: monospace; font-size: 0.8rem; background: rgba(99, 102, 241, 0.15); color: #a5b4fc; border: 1px solid rgba(99, 102, 241, 0.35); padding: 0.35rem 0.65rem;">
                            <i class="ph ph-calendar-check"></i> ${file.periode_label || file.periode}
                        </span>
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
            backupTableBody.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 2rem; color: #ef4444;">Gagal memuat data cadangan: ${e.message}</td></tr>`;
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

// =========================================================================
// Create Backup Modal & Handlers
// =========================================================================

const modalBackup = document.getElementById('modal-backup');
const btnCloseBackupModal = document.getElementById('btn-close-backup-modal');
const btnCancelBackupModal = document.getElementById('btn-cancel-backup-modal');
const formCreateBackup = document.getElementById('form-create-backup');
const inputBackupCustomLabel = document.getElementById('backup-custom-label');
const backupFilenamePreview = document.getElementById('backup-filename-preview');

function updateBackupFilenamePreview() {
    if (!backupFilenamePreview) return;
    const selectedTypeEl = document.querySelector('input[name="backup_type"]:checked');
    const type = selectedTypeEl ? selectedTypeEl.value : 'MANUAL';
    const labelRaw = inputBackupCustomLabel ? inputBackupCustomLabel.value.trim() : '';
    
    let cleanLabel = labelRaw.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^_+|_+$/g, '').substring(0, 30);
    const labelPart = cleanLabel ? `_${cleanLabel}` : '';
    
    // Perkiraan periode aktif
    const now = new Date();
    const curYear = now.getFullYear();
    const curMonth = String(now.getMonth() + 1).padStart(2, '0');
    const curTimestamp = `${curYear}${curMonth}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    
    // Tagihan p-active vs Rekening p-active
    const periodStr = `${curYear}${curMonth}`;
    
    backupFilenamePreview.textContent = `simpadu_${type}${labelPart}_p${periodStr}_${curTimestamp}.sql.gz`;
}

function openBackupModal() {
    if (!modalBackup) return;
    const defaultRadio = document.querySelector('input[name="backup_type"][value="MANUAL"]');
    if (defaultRadio) defaultRadio.checked = true;
    if (inputBackupCustomLabel) inputBackupCustomLabel.value = '';
    updateBackupFilenamePreview();
    modalBackup.style.display = 'flex';
}

function closeBackupModal() {
    if (modalBackup) modalBackup.style.display = 'none';
}

if (btnCloseBackupModal) btnCloseBackupModal.addEventListener('click', closeBackupModal);
if (btnCancelBackupModal) btnCancelBackupModal.addEventListener('click', closeBackupModal);

if (modalBackup) {
    modalBackup.addEventListener('click', (e) => {
        if (e.target === modalBackup) closeBackupModal();
    });
}

document.querySelectorAll('input[name="backup_type"]').forEach(radio => {
    radio.addEventListener('change', updateBackupFilenamePreview);
});
if (inputBackupCustomLabel) {
    inputBackupCustomLabel.addEventListener('input', updateBackupFilenamePreview);
}

if (btnRunBackupNow) {
    btnRunBackupNow.addEventListener('click', () => {
        openBackupModal();
    });
}

if (formCreateBackup) {
    formCreateBackup.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const selectedTypeEl = document.querySelector('input[name="backup_type"]:checked');
        const type = selectedTypeEl ? selectedTypeEl.value : 'MANUAL';
        const label = inputBackupCustomLabel ? inputBackupCustomLabel.value.trim() : '';

        closeBackupModal();

        btnRunBackupNow.disabled = true;
        btnRunBackupNow.classList.add('btn-loading');
        btnRunBackupNow.innerHTML = '<i class="ph ph-spinner spinner"></i> Memulai Cadangan...';

        try {
            const res = await fetch('api.php?action=run_backup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type, label })
            });
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
const btnResetPipelineStepper = document.getElementById('btn-reset-pipeline-stepper');
const pipelineConsoleOutput = document.getElementById('pipeline-console-output');
const pipelineHistoryTbody = document.getElementById('pipeline-history-tbody');
const pipelineBatchIdBadge = document.getElementById('pipeline-batch-id-badge');
const pipelineLiveIndicator = document.getElementById('pipeline-live-indicator');
const pipelineStatusBadge = document.getElementById('pipeline-status-badge');

let pipelineLiveTimerInterval = null;
let pipelinePollerInterval = null;
let pipelineStartTimestamp = null;
let isManualPipelineReset = localStorage.getItem('pipeline_view_standby') === '1';

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
    if (pipelineStatusBadge) {
        pipelineStatusBadge.innerHTML = '<i class="ph ph-shield-check"></i> Siap Eksekusi';
        pipelineStatusBadge.className = 'badge badge-purple';
    }
    const pipelineQueryTicker = document.getElementById('pipeline-query-ticker');
    const pipelineTableBadge = document.getElementById('pipeline-active-table-badge');
    if (pipelineQueryTicker) {
        pipelineQueryTicker.textContent = 'Standby: Menunggu eksekusi pipeline...';
    }
    if (pipelineTableBadge) {
        pipelineTableBadge.textContent = 'Tabel: -';
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
            const isAnyRunning = json.batches.some(b => b.status === 'RUNNING');
            if (isAnyRunning) {
                isManualPipelineReset = false;
                localStorage.removeItem('pipeline_view_standby');
            }

            const isStandbyActive = (isManualPipelineReset || localStorage.getItem('pipeline_view_standby') === '1') && !isAnyRunning;

            if (isStandbyActive) {
                resetAllStepCards();
            } else if (latestBatch && latestBatch.steps) {
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

    localStorage.removeItem('pipeline_view_standby');
    isManualPipelineReset = false;

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
if (btnResetPipelineStepper) {
    btnResetPipelineStepper.addEventListener('click', async () => {
        if (!confirm('Apakah Anda yakin ingin me-reset status alur eksekusi ke STANDBY?\n\nTindakan ini akan membatalkan antrean running/pending lama dan mengembalikan status sistem ke normal.')) {
            return;
        }
        btnResetPipelineStepper.disabled = true;
        btnResetPipelineStepper.innerHTML = '<i class="ph ph-spinner spinner"></i> Mereset...';
        try {
            const res = await fetch('api.php?action=reset_pipeline_status', { method: 'POST' });
            const json = await res.json();
            if (json.status === 'success') {
                localStorage.setItem('pipeline_view_standby', '1');
                isManualPipelineReset = true;
                resetAllStepCards();
                if (pipelineConsoleOutput) {
                    pipelineConsoleOutput.textContent = `[${new Date().toLocaleTimeString('id-ID')}] Status alur eksekusi berhasil di-reset ke Standby.\n`;
                }
                showNotification('Sukses', json.message || 'Status alur berhasil di-reset ke Standby.', 'success');
                await loadAutomationConfig();
                await loadPipelineLogs();
            } else {
                showNotification('Gagal', json.message || 'Gagal mereset status alur.', 'danger');
            }
        } catch (err) {
            showNotification('Error', 'Terjadi kesalahan jaringan: ' + err.message, 'danger');
        } finally {
            btnResetPipelineStepper.disabled = false;
            btnResetPipelineStepper.innerHTML = '<i class="ph ph-arrow-counter-clockwise"></i> Reset ke Standby';
        }
    });
}

// ==========================================
// CLOSING REKENING PIPELINE & SCHEDULER
// ==========================================

const rekStepNamesDef = [
    'Maintenance Mode (OFFLINE = 0)',
    'Pencadangan Database simpadu',
    'Closing Rekening',
    'Transfer PPOB',
    'Pelunasan Rumah Ibadah',
    'Mode Online Kembali (OFFLINE = 1)'
];

let rekeningCountdownInterval = null;
let rekeningTabAutoPoller = null;
let rekeningLiveTimerInterval = null;
let rekeningStartTimestamp = null;
let isManualRekeningReset = false;

// Rekening Elements
const formRekeningSchedule = document.getElementById('form-rekening-schedule');
const cfgRekeningPeriode = document.getElementById('cfg-rekening-periode');
const cfgRekeningJadwal = document.getElementById('cfg-rekening-jadwal');
const btnPresetRek2Min = document.getElementById('btn-preset-rek-2min');
const btnPresetRek1st = document.getElementById('btn-preset-rek-1st');
const btnSaveRekeningConfig = document.getElementById('btn-save-rekening-config');
const btnRefreshRekeningConfigs = document.getElementById('btn-refresh-rekening-configs');
const rekeningConfigTbody = document.getElementById('rekening-config-tbody');

const btnRunRekeningPipeline = document.getElementById('btn-run-rekening-pipeline');
const btnRefreshRekeningLogs = document.getElementById('btn-refresh-rekening-logs');
const btnResetRekeningStepper = document.getElementById('btn-reset-rekening-stepper');
const pipelineRekeningHistoryTbody = document.getElementById('pipeline-rekening-history-tbody');
const pipelineRekeningConsoleOutput = document.getElementById('pipeline-rekening-console-output');
const pipelineRekeningBatchIdBadge = document.getElementById('pipeline-rekening-batch-id-badge');
const pipelineRekeningLiveIndicator = document.getElementById('pipeline-rekening-live-indicator');
const pipelineRekeningStatusBadge = document.getElementById('pipeline-rekening-status-badge');

function getDefault1stSchedule(periode) {
    if (!periode || periode.length !== 6) return '';
    let y = parseInt(periode.substring(0, 4), 10);
    let m = parseInt(periode.substring(4, 6), 10);
    m += 1;
    if (m > 12) {
        m = 1;
        y += 1;
    }
    const mm = String(m).padStart(2, '0');
    return `${y}-${mm}-01T00:00`;
}

function startRekeningCountdownTimer(targetDateStr, status) {
    if (rekeningCountdownInterval) {
        clearInterval(rekeningCountdownInterval);
        rekeningCountdownInterval = null;
    }

    const timerEl = document.getElementById('rekening-countdown-timer');
    const detailEl = document.getElementById('rekening-countdown-detail');
    const badgeEl = document.getElementById('pipeline-rekening-status-badge');

    if (!targetDateStr || status === 'COMPLETED' || status === 'SUCCESS') {
        if (timerEl) timerEl.textContent = 'STANDBY';
        if (detailEl) detailEl.textContent = status === 'SUCCESS' ? 'Eksekusi batch closing rekening terakhir selesai sukses.' : 'Sistem siap untuk eksekusi closing rekening bulanan.';
        if (badgeEl) {
            badgeEl.className = 'badge badge-success';
            badgeEl.innerHTML = '<i class="ph ph-check-circle"></i> Standby (Selesai)';
        }
        return;
    }

    const targetTime = new Date(targetDateStr.replace(' ', 'T')).getTime();

    function update() {
        const now = new Date().getTime();
        const diff = targetTime - now;

        if (diff <= 0) {
            if (diff < -15 * 60 * 1000) {
                if (timerEl) timerEl.textContent = 'STANDBY';
                if (detailEl) detailEl.textContent = `Jadwal ${targetDateStr} telah terlewati. Silakan tentukan jadwal baru.`;
                if (badgeEl) {
                    badgeEl.className = 'badge badge-secondary';
                    badgeEl.textContent = 'KEDALUWARSA / STANDBY';
                }
                if (rekeningCountdownInterval) {
                    clearInterval(rekeningCountdownInterval);
                    rekeningCountdownInterval = null;
                }
                return;
            }

            if (timerEl) timerEl.textContent = '00:00:00 (Jatuh Tempo)';
            if (badgeEl) {
                badgeEl.className = 'badge badge-warning';
                badgeEl.textContent = 'MENGEKSEKUSI...';
            }
            if (rekeningCountdownInterval) {
                clearInterval(rekeningCountdownInterval);
                rekeningCountdownInterval = null;
            }
            return;
        }

        const days = Math.floor(diff / (1000 * 60 * 60 * 24));
        const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((diff % (1000 * 60)) / 1000);

        let timerText = '';
        if (days > 0) timerText += `${days}h `;
        timerText += `${String(hours).padStart(2, '0')}j ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}d`;

        if (timerEl) timerEl.textContent = timerText;
        if (detailEl) detailEl.textContent = `Target: ${targetDateStr}`;
        if (badgeEl) {
            badgeEl.className = 'badge badge-info';
            badgeEl.innerHTML = `<i class="ph ph-clock"></i> PENDING (${days > 0 ? days + ' hari lagi' : (hours > 0 ? hours + ' jam ' : '') + minutes + 'm ' + seconds + 's'})`;
        }
    }

    update();
    rekeningCountdownInterval = setInterval(update, 1000);
}

async function loadRekeningConfig() {
    try {
        const res = await fetch('api.php?action=get_rekening_config');
        const json = await res.json();
        const displayAuto = document.getElementById('display-auto-rekening-periode');
        const targetPeriode = json.target_periode_eksekusi || '202609';

        if (cfgRekeningPeriode) {
            cfgRekeningPeriode.value = targetPeriode;
        }
        if (displayAuto) {
            displayAuto.textContent = `${targetPeriode} (Aktif SIMPADU: ${json.periode_aktif_db || '-'})`;
        }

        if (json.status === 'success' && json.data && json.data.length > 0) {
            let activeCfg = json.data.find(c => c.status === 'PENDING');
            if (!activeCfg) activeCfg = json.data.find(c => c.status === 'RUNNING');
            if (!activeCfg) activeCfg = json.data.find(c => c.periode === targetPeriode);
            if (!activeCfg) activeCfg = json.data[0];

            if (cfgRekeningJadwal && activeCfg.jadwal_eksekusi) {
                const dt = new Date(activeCfg.jadwal_eksekusi.replace(' ', 'T'));
                cfgRekeningJadwal.value = formatDatetimeForInput(dt);
            }
            startRekeningCountdownTimer(activeCfg.jadwal_eksekusi, activeCfg.status);

            if (rekeningConfigTbody) {
                let html = '';
                json.data.forEach(cfg => {
                    let badgeClass = 'badge-info';
                    if (cfg.status === 'SUCCESS') badgeClass = 'badge-success';
                    else if (cfg.status === 'FAILED') badgeClass = 'badge-danger';
                    else if (cfg.status === 'RUNNING') badgeClass = 'badge-warning';

                    const catatan = cfg.pesan_terakhir || '-';

                    html += `
                        <tr>
                            <td><strong>#${cfg.id}</strong></td>
                            <td><span class="badge badge-purple">${cfg.periode}</span></td>
                            <td><strong>${cfg.jadwal_eksekusi}</strong></td>
                            <td><span class="badge ${badgeClass}">${cfg.status}</span></td>
                            <td><small style="max-width: 180px; display: inline-block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${catatan}">${catatan}</small></td>
                        </tr>
                    `;
                });
                rekeningConfigTbody.innerHTML = html;
            }
        } else {
            if (cfgRekeningJadwal && !cfgRekeningJadwal.value) {
                cfgRekeningJadwal.value = getDefault1stSchedule(targetPeriode);
            }
            startRekeningCountdownTimer(cfgRekeningJadwal ? cfgRekeningJadwal.value.replace('T', ' ') : null, 'PENDING');
            if (rekeningConfigTbody) {
                rekeningConfigTbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-secondary); padding: 1.5rem;">Belum ada jadwal antrean tercatat untuk closing rekening.</td></tr>';
            }
        }
    } catch (e) {
        console.error('Gagal mengambil konfigurasi closing rekening:', e);
    }
}

function updateRekeningProgressUI(stepIndex, status, customTitle, isDone = false) {
    const fill = document.getElementById('pipeline-rekening-progress-fill');
    const percentEl = document.getElementById('pipeline-rekening-progress-percent');
    const titleEl = document.getElementById('pipeline-rekening-progress-phase-title');
    const radar = document.getElementById('pipeline-rekening-radar-pulse');

    if (!fill || !percentEl || !titleEl) return;

    let pct = 0;
    if (isDone) {
        pct = 100;
    } else if (stepIndex >= 0) {
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
    } else if (stepIndex >= 0 && rekStepNamesDef[stepIndex]) {
        titleEl.textContent = (status === 'RUNNING' ? 'Sedang Memproses ' : 'Selesai ') + rekStepNamesDef[stepIndex];
    } else if (isDone) {
        titleEl.textContent = 'Semua 6 Tahapan Closing Rekening Selesai dengan Sukses!';
    } else {
        titleEl.textContent = 'Standby: Siap Dijalankan';
    }

    if (radar) {
        radar.className = 'radar-pulse-dot';
        if (status === 'RUNNING') radar.classList.add('running');
        else if (status === 'SUCCESS' || isDone) radar.classList.add('success');
        else if (status === 'FAILED') radar.classList.add('failed');
    }

    for (let i = 0; i <= 5; i++) {
        const sub = document.getElementById(`subtext-rek-step-${i}`);
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

function startRekeningStopwatch() {
    stopRekeningStopwatch();
    rekeningStartTimestamp = Date.now();
    const timerBadge = document.getElementById('pipeline-rekening-live-timer');
    rekeningLiveTimerInterval = setInterval(() => {
        if (!timerBadge) return;
        const elapsedSec = Math.floor((Date.now() - rekeningStartTimestamp) / 1000);
        const m = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
        const s = String(elapsedSec % 60).padStart(2, '0');
        timerBadge.innerHTML = `<i class="ph ph-timer"></i> ${m}:${s}`;
    }, 1000);
}

function stopRekeningStopwatch(finalText = null) {
    if (rekeningLiveTimerInterval) {
        clearInterval(rekeningLiveTimerInterval);
        rekeningLiveTimerInterval = null;
    }
    const timerBadge = document.getElementById('pipeline-rekening-live-timer');
    if (timerBadge && finalText) {
        timerBadge.innerHTML = `<i class="ph ph-check-circle"></i> ${finalText}`;
    }
}

function updateRekeningStepCardUI(stepNum, status, metaText) {
    const card = document.getElementById(`rek-step-card-${stepNum}`);
    const badge = document.getElementById(`rek-step-badge-${stepNum}`);
    const meta = document.getElementById(`rek-step-meta-${stepNum}`);
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

    const connectors = document.querySelectorAll('#closing-rekening-section .pipeline-stepper-grid .step-connector');
    if (connectors && connectors.length > stepNum) {
        const conn = connectors[stepNum];
        if (conn) {
            conn.classList.remove('active', 'done');
            if (status === 'SUCCESS') conn.classList.add('done');
            else if (status === 'RUNNING') conn.classList.add('active');
        }
    }
}

function resetAllRekeningStepCards() {
    for (let i = 0; i <= 5; i++) {
        updateRekeningStepCardUI(i, 'STANDBY', '-');
    }
    const connectors = document.querySelectorAll('#closing-rekening-section .pipeline-stepper-grid .step-connector');
    if (connectors) {
        connectors.forEach(c => c.classList.remove('active', 'done'));
    }
    if (pipelineRekeningBatchIdBadge) pipelineRekeningBatchIdBadge.textContent = 'Batch: Siap Dijalankan';
    if (pipelineRekeningLiveIndicator) {
        pipelineRekeningLiveIndicator.textContent = 'IDLE';
        pipelineRekeningLiveIndicator.className = 'badge badge-secondary';
    }
    if (pipelineRekeningStatusBadge) {
        pipelineRekeningStatusBadge.innerHTML = '<i class="ph ph-shield-check"></i> Siap Eksekusi';
        pipelineRekeningStatusBadge.className = 'badge badge-info';
    }
    const queryTicker = document.getElementById('pipeline-rekening-query-ticker');
    const tableBadge = document.getElementById('pipeline-rekening-active-table-badge');
    if (queryTicker) {
        queryTicker.textContent = 'Standby: Menunggu eksekusi pipeline closing rekening...';
    }
    if (tableBadge) {
        tableBadge.textContent = 'Tabel: -';
    }
    updateRekeningProgressUI(-1, 'STANDBY', 'Standby: Menunggu Eksekusi', false);
    stopRekeningStopwatch();
    const timerBadge = document.getElementById('pipeline-rekening-live-timer');
    if (timerBadge) timerBadge.innerHTML = '<i class="ph ph-timer"></i> 00:00';
}

function startRekeningTabAutoPoller() {
    if (rekeningTabAutoPoller) clearInterval(rekeningTabAutoPoller);
    rekeningTabAutoPoller = setInterval(() => {
        loadRekeningPipelineLogs();
    }, 2000);
}

function stopRekeningTabAutoPoller() {
    if (rekeningTabAutoPoller) {
        clearInterval(rekeningTabAutoPoller);
        rekeningTabAutoPoller = null;
    }
}

async function loadRekeningPipelineLogs() {
    if (!pipelineRekeningHistoryTbody) return;

    try {
        const res = await fetch('api.php?action=get_rekening_pipeline_logs&limit=50');
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
                        <td><code style="color: #38bdf8; font-size: 0.75rem;">${b.batch_id}</code></td>
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
            pipelineRekeningHistoryTbody.innerHTML = html;

            const latestBatch = json.batches[0];
            const isAnyRunning = json.batches.some(b => b.status === 'RUNNING');
            if (isAnyRunning) {
                isManualRekeningReset = false;
                localStorage.removeItem('rekening_view_standby');
            }

            const isStandbyActive = (isManualRekeningReset || localStorage.getItem('rekening_view_standby') === '1') && !isAnyRunning;

            if (isStandbyActive) {
                resetAllRekeningStepCards();
            } else if (latestBatch && latestBatch.steps) {
                if (pipelineRekeningBatchIdBadge) {
                    pipelineRekeningBatchIdBadge.textContent = `Batch: ${latestBatch.batch_id} (${latestBatch.periode})`;
                }

                for (let i = 0; i <= 5; i++) {
                    updateRekeningStepCardUI(i, 'STANDBY', '');
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
                        updateRekeningStepCardUI(stepNum, st.status, `${dur} | ${timeStr}`);
                        if (stepNum > highestStep) highestStep = stepNum;
                        if (st.status === 'RUNNING') {
                            hasRunning = true;
                            if (stepNum === 1) step1IsRunning = true;
                        }
                        if (st.status === 'FAILED') hasFailed = true;
                    }
                });

                if (latestBatch.status === 'SUCCESS' && latestBatch.steps.length >= 6) {
                    updateRekeningProgressUI(5, 'SUCCESS', 'Closing Rekening Terakhir Berhasil Selesai Penuh (6/6 Tahap)', true);
                    if (pipelineRekeningLiveIndicator) {
                        pipelineRekeningLiveIndicator.textContent = 'COMPLETED';
                        pipelineRekeningLiveIndicator.className = 'badge badge-success';
                    }
                    if (pipelineRekeningStatusBadge) {
                        pipelineRekeningStatusBadge.innerHTML = '<i class="ph ph-check-circle"></i> SUKSES PENUH';
                        pipelineRekeningStatusBadge.className = 'badge badge-success';
                    }
                } else if (hasRunning || latestBatch.status === 'RUNNING') {
                    if (pipelineRekeningLiveIndicator) {
                        pipelineRekeningLiveIndicator.textContent = 'RUNNING';
                        pipelineRekeningLiveIndicator.className = 'badge badge-warning';
                    }
                    if (pipelineRekeningStatusBadge) {
                        pipelineRekeningStatusBadge.innerHTML = '<i class="ph ph-spinner spinner"></i> SEDANG BERJALAN...';
                        pipelineRekeningStatusBadge.className = 'badge badge-warning';
                    }
                    updateRekeningProgressUI(highestStep, 'RUNNING', `Sedang Berjalan: ${rekStepNamesDef[highestStep] || 'Tahap ' + highestStep}`);
                } else if (hasFailed || latestBatch.status === 'FAILED') {
                    if (pipelineRekeningLiveIndicator) {
                        pipelineRekeningLiveIndicator.textContent = 'FAILED';
                        pipelineRekeningLiveIndicator.className = 'badge badge-danger';
                    }
                    if (pipelineRekeningStatusBadge) {
                        pipelineRekeningStatusBadge.innerHTML = '<i class="ph ph-warning"></i> GAGAL';
                        pipelineRekeningStatusBadge.className = 'badge badge-danger';
                    }
                    updateRekeningProgressUI(highestStep, 'FAILED', `Gagal pada ${rekStepNamesDef[highestStep] || 'Tahap ' + highestStep}`);
                }

                if (step1IsRunning && json.active_backup && json.active_backup.is_writing) {
                    const ab = json.active_backup;
                    const cardMeta1 = document.getElementById('rek-step-meta-1');
                    if (cardMeta1) {
                        cardMeta1.innerHTML = `<span style="color: #38bdf8; font-weight: 600;"><i class="ph ph-arrows-clockwise spinner"></i> ${ab.display_text}</span>`;
                    }
                    const phaseTitle = document.getElementById('pipeline-rekening-progress-phase-title');
                    if (phaseTitle && highestStep === 1) {
                        phaseTitle.textContent = `Tahap 1: Pencadangan Database (${ab.display_text})`;
                    }
                }

                const queryTicker = document.getElementById('pipeline-rekening-query-ticker');
                const tableBadge = document.getElementById('pipeline-rekening-active-table-badge');
                if (tableBadge && json.active_table) {
                    tableBadge.textContent = `Tabel: ${json.active_table}`;
                }
                if (queryTicker) {
                    if (json.query_snippet) {
                        queryTicker.textContent = `[${new Date().toLocaleTimeString('id-ID')}] ${json.query_snippet}`;
                    } else if (latestBatch.status === 'SUCCESS') {
                        queryTicker.textContent = 'Semua operasi SQL 6 tahap closing rekening telah selesai dengan sukses.';
                        if (tableBadge) tableBadge.textContent = 'Selesai';
                    }
                }
            }
        } else {
            pipelineRekeningHistoryTbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-secondary); padding: 1.5rem;">Belum ada riwayat batch closing rekening.</td></tr>';
        }
    } catch (e) {
        console.error('Gagal memuat log closing rekening:', e);
    }
}

async function runClosingRekeningPipeline() {
    if (!confirm("PERINGATAN:\nAnda akan menjalankan CLOSING REKENING PIPELINE (6 TAHAPAN BERURUTAN):\n\n1. Tahap 0: Set OFFLINE = '0' (Maintenance)\n2. Tahap 1: Backup Database simpadu (CLOSING_REKENING)\n3. Tahap 2: Closing Rekening Air\n4. Tahap 3: Transfer PPOB\n5. Tahap 4: Pelunasan Rumah Ibadah\n6. Tahap 5: Set OFFLINE = '1' (Online)\n\nLanjutkan eksekusi penuh sekarang?")) {
        return;
    }

    if (!btnRunRekeningPipeline) return;

    localStorage.removeItem('rekening_view_standby');
    isManualRekeningReset = false;

    btnRunRekeningPipeline.disabled = true;
    btnRunRekeningPipeline.classList.add('btn-loading');
    btnRunRekeningPipeline.innerHTML = '<i class="ph ph-spinner spinner"></i> Sedang Memproses Closing Rekening...';

    if (pipelineRekeningLiveIndicator) {
        pipelineRekeningLiveIndicator.textContent = 'RUNNING';
        pipelineRekeningLiveIndicator.className = 'badge badge-warning';
    }
    if (pipelineRekeningStatusBadge) {
        pipelineRekeningStatusBadge.innerHTML = '<i class="ph ph-spinner spinner"></i> MEMPROSES...';
        pipelineRekeningStatusBadge.className = 'badge badge-warning';
    }

    resetAllRekeningStepCards();
    startRekeningStopwatch();
    updateRekeningStepCardUI(0, 'RUNNING', 'Memulai...');
    updateRekeningProgressUI(0, 'RUNNING', 'Tahap 0: Set Mode Maintenance (OFFLINE = 0)...');
    if (pipelineRekeningConsoleOutput) {
        pipelineRekeningConsoleOutput.textContent = `[${new Date().toLocaleTimeString('id-ID')}] Memulai eksekusi Closing Rekening Pipeline 6-Tahapan...\n`;
    }

    let poller = setInterval(async () => {
        try {
            const res = await fetch('api.php?action=get_rekening_pipeline_logs&limit=5');
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
                            updateRekeningStepCardUI(stepNum, st.status, `${dur} | ${timeStr}`);
                            if (stepNum > highest) highest = stepNum;
                        }
                    });
                    const lastStep = cur.steps[cur.steps.length - 1];
                    if (lastStep) {
                        updateRekeningProgressUI(parseInt(lastStep.step, 10), lastStep.status, null);
                    }
                }

                const queryTicker = document.getElementById('pipeline-rekening-query-ticker');
                const tableBadge = document.getElementById('pipeline-rekening-active-table-badge');
                if (tableBadge && json.active_table) {
                    tableBadge.textContent = `Tabel: ${json.active_table}`;
                }
                if (queryTicker && json.query_snippet) {
                    queryTicker.textContent = `[${new Date().toLocaleTimeString('id-ID')}] ${json.query_snippet}`;
                }
            }
        } catch (e) {
            // silent
        }
    }, 1500);

    try {
        const res = await fetch('api.php?action=run_rekening_pipeline', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                executed_by: 'WEB_DASHBOARD',
                periode: cfgRekeningPeriode ? cfgRekeningPeriode.value : '',
                user_id: 1
            })
        });

        clearInterval(poller);
        const json = await res.json();

        if (json.data && json.data.logs && pipelineRekeningConsoleOutput) {
            pipelineRekeningConsoleOutput.textContent = json.data.logs.join('\n');
            pipelineRekeningConsoleOutput.scrollTop = pipelineRekeningConsoleOutput.scrollHeight;
        }

        if (json.status === 'success') {
            const data = json.data;
            if (pipelineRekeningBatchIdBadge) pipelineRekeningBatchIdBadge.textContent = `Batch: ${data.batch_id} (${data.periode})`;
            if (pipelineRekeningLiveIndicator) {
                pipelineRekeningLiveIndicator.textContent = 'COMPLETED';
                pipelineRekeningLiveIndicator.className = 'badge badge-success';
            }
            if (pipelineRekeningStatusBadge) {
                pipelineRekeningStatusBadge.innerHTML = '<i class="ph ph-check-circle"></i> SUKSES PENUH';
                pipelineRekeningStatusBadge.className = 'badge badge-success';
            }

            for (let i = 0; i <= 5; i++) {
                if (data.steps && data.steps[i]) {
                    updateRekeningStepCardUI(i, 'SUCCESS', data.steps[i].pesan || 'Selesai');
                }
            }

            stopRekeningStopwatch(`${data.durasi_total_detik}s`);
            updateRekeningProgressUI(5, 'SUCCESS', `Closing Rekening Selesai Sukses Penuh (${data.durasi_total_detik} detik)`, true);

            showNotification('Sukses', `Closing Rekening 6-Tahap Sukses Penuh!\n\nBatch ID: ${data.batch_id}\nTotal Durasi: ${data.durasi_total_detik} detik`, 'success');
            loadRekeningPipelineLogs();
            loadRekeningConfig();
        } else {
            clearInterval(poller);
            if (pipelineRekeningLiveIndicator) {
                pipelineRekeningLiveIndicator.textContent = 'FAILED';
                pipelineRekeningLiveIndicator.className = 'badge badge-danger';
            }
            if (pipelineRekeningStatusBadge) {
                pipelineRekeningStatusBadge.innerHTML = '<i class="ph ph-warning"></i> GAGAL';
                pipelineRekeningStatusBadge.className = 'badge badge-danger';
            }
            stopRekeningStopwatch('Gagal');
            updateRekeningProgressUI(0, 'FAILED', `Closing Rekening Gagal: ${json.message || json.error}`, false);
            showNotification('Gagal', `Closing Rekening Terhenti!\n\nDetail: ${json.message || json.error}`, 'danger');
            loadRekeningPipelineLogs();
        }
    } catch (err) {
        clearInterval(poller);
        stopRekeningStopwatch('Error');
        updateRekeningProgressUI(0, 'FAILED', 'Terjadi kesalahan jaringan/timeout', false);
        showNotification('Error', 'Terjadi kesalahan koneksi atau eksekusi: ' + err.message, 'danger');
        if (pipelineRekeningLiveIndicator) {
            pipelineRekeningLiveIndicator.textContent = 'ERROR';
            pipelineRekeningLiveIndicator.className = 'badge badge-danger';
        }
    } finally {
        clearInterval(poller);
        btnRunRekeningPipeline.disabled = false;
        btnRunRekeningPipeline.classList.remove('btn-loading');
        btnRunRekeningPipeline.innerHTML = '<i class="ph ph-play"></i> Jalankan Closing Rekening Sekarang';
    }
}

if (btnRunRekeningPipeline) {
    btnRunRekeningPipeline.addEventListener('click', runClosingRekeningPipeline);
}
if (btnRefreshRekeningLogs) {
    btnRefreshRekeningLogs.addEventListener('click', loadRekeningPipelineLogs);
}
if (btnRefreshRekeningConfigs) {
    btnRefreshRekeningConfigs.addEventListener('click', loadRekeningConfig);
}
if (btnPresetRek2Min) {
    btnPresetRek2Min.addEventListener('click', () => {
        const now = new Date();
        now.setMinutes(now.getMinutes() + 2);
        if (cfgRekeningJadwal) {
            cfgRekeningJadwal.value = formatDatetimeForInput(now);
            startRekeningCountdownTimer(cfgRekeningJadwal.value.replace('T', ' ') + ':00', 'PENDING');
        }
    });
}
if (btnPresetRek1st) {
    btnPresetRek1st.addEventListener('click', () => {
        const p = (cfgRekeningPeriode ? cfgRekeningPeriode.value : '').trim();
        if (cfgRekeningJadwal && p.length === 6) {
            cfgRekeningJadwal.value = getDefault1stSchedule(p);
            startRekeningCountdownTimer(cfgRekeningJadwal.value.replace('T', ' ') + ':00', 'PENDING');
        }
    });
}
if (formRekeningSchedule) {
    formRekeningSchedule.addEventListener('submit', async (e) => {
        e.preventDefault();
        const periode = (cfgRekeningPeriode ? cfgRekeningPeriode.value : '').trim();
        let jadwal = cfgRekeningJadwal ? cfgRekeningJadwal.value : '';

        if (!periode || periode.length !== 6) {
            alert('Format periode tidak valid! Harus 6 digit YYYYMM (contoh: 202609).');
            return;
        }

        if (jadwal) {
            jadwal = jadwal.replace('T', ' ');
            if (jadwal.length === 16) jadwal += ':00';
        }

        const btnSave = document.getElementById('btn-save-rekening-config');
        if (btnSave) {
            btnSave.disabled = true;
            btnSave.innerHTML = '<i class="ph ph-spinner spinner"></i> Menyimpan...';
        }

        try {
            const res = await fetch('api.php?action=save_rekening_config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    periode: periode, 
                    jadwal_eksekusi: jadwal,
                    user_id: 1 
                })
            });
            const json = await res.json();
            if (json.status === 'success') {
                showNotification('Sukses', json.message || 'Jadwal closing rekening berhasil disimpan!', 'success');
                startRekeningCountdownTimer(jadwal, 'PENDING');
                loadRekeningConfig();
            } else {
                showNotification('Gagal', json.error || json.message || 'Gagal menyimpan konfigurasi', 'danger');
            }
        } catch (err) {
            showNotification('Error', 'Terjadi kesalahan jaringan: ' + err.message, 'danger');
        } finally {
            if (btnSave) {
                btnSave.disabled = false;
                btnSave.innerHTML = '<i class="ph ph-floppy-disk"></i> Simpan Jadwal Antrean';
            }
        }
    });
}
if (btnResetRekeningStepper) {
    btnResetRekeningStepper.addEventListener('click', async () => {
        if (!confirm('Apakah Anda yakin ingin me-reset status alur closing rekening ke STANDBY?\n\nTindakan ini akan membatalkan antrean running/pending lama dan mengembalikan status sistem ke normal.')) {
            return;
        }
        btnResetRekeningStepper.disabled = true;
        btnResetRekeningStepper.innerHTML = '<i class="ph ph-spinner spinner"></i> Mereset...';
        try {
            const res = await fetch('api.php?action=reset_rekening_pipeline_status', { method: 'POST' });
            const json = await res.json();
            if (json.status === 'success') {
                localStorage.setItem('rekening_view_standby', '1');
                isManualRekeningReset = true;
                resetAllRekeningStepCards();
                if (pipelineRekeningConsoleOutput) {
                    pipelineRekeningConsoleOutput.textContent = `[${new Date().toLocaleTimeString('id-ID')}] Status alur eksekusi closing rekening berhasil di-reset ke Standby.\n`;
                }
                showNotification('Sukses', json.message || 'Status alur closing rekening berhasil di-reset ke Standby.', 'success');
                await loadRekeningConfig();
                await loadRekeningPipelineLogs();
            } else {
                showNotification('Gagal', json.message || 'Gagal mereset status alur.', 'danger');
            }
        } catch (err) {
            showNotification('Error', 'Terjadi kesalahan jaringan: ' + err.message, 'danger');
        } finally {
            btnResetRekeningStepper.disabled = false;
            btnResetRekeningStepper.innerHTML = '<i class="ph ph-arrow-counter-clockwise"></i> Reset ke Standby';
        }
    });
}

// Init
const urlParams = new URLSearchParams(window.location.search);
const paramTab = urlParams.get('tab');
const paramDate = urlParams.get('date');
const autoLoad = urlParams.get('autoload');

if (paramTab && (paramTab === 'beli' || paramTab === 'batal' || paramTab === 'dibeli' || paramTab === 'otomasi' || paramTab === 'pipeline' || paramTab === 'closing_rekening' || paramTab === 'backup')) {
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

// ==========================================================================
// Server Health, Closing Diagnostics & Storage Monitor
// ==========================================================================
let serverMetricsPoller = null;
let lastMetricsData = null;

async function loadServerMetrics(showFeedback = false) {
    const btnRefreshDiag = document.getElementById('btn-refresh-diag');
    if (showFeedback && btnRefreshDiag) {
        btnRefreshDiag.innerHTML = '<i class="ph ph-spinner-gap ph-spin"></i> Memuat...';
        btnRefreshDiag.disabled = true;
    }

    try {
        const res = await fetch('api.php?action=get_server_metrics');
        if (!res.ok) throw new Error('Network error');
        const json = await res.json();
        if (json.status !== 'success') throw new Error(json.message || 'API error');

        lastMetricsData = json;

        // Determine active server key
        const isSimpadu = (json.database && (json.database.host === '192.168.8.11' || json.database.env_type === 'Production'));
        const activeServerKey = isSimpadu ? 'simpadu' : 'simpam';
        updateServerSwitcherUI(activeServerKey);

        // 1. Sidebar Elements
        const diskFreeEl = document.getElementById('sidebar-disk-free');
        const diskFillEl = document.getElementById('sidebar-disk-fill');
        const diskSubEl = document.getElementById('sidebar-disk-sub');
        const ramTextEl = document.getElementById('sidebar-ram-text');
        const ramFillEl = document.getElementById('sidebar-ram-fill');
        const cpuTextEl = document.getElementById('sidebar-cpu-text');
        const dbTextEl = document.getElementById('sidebar-db-text');
        const statusBadgeEl = document.getElementById('sidebar-status-badge');
        const dbLabelEl = document.getElementById('sidebar-db-label');
        const backupTextEl = document.getElementById('sidebar-last-backup-text');
        const conflictPillEl = document.getElementById('sidebar-conflict-pill');
        const conflictTextEl = document.getElementById('sidebar-conflict-text');

        // Topbar Ping
        const topbarDbPingEl = document.getElementById('topbar-db-ping');

        // Database info
        if (json.database) {
            const labelStr = json.database.label || `${json.database.host}:${json.database.port}`;
            if (dbLabelEl) dbLabelEl.textContent = `DB: ${labelStr}`;
            if (topbarDbPingEl) topbarDbPingEl.textContent = `${json.database.ping_ms || 0} ms`;
            if (dbTextEl) dbTextEl.textContent = json.database.size_formatted;
        }

        // Storage / Disk
        if (json.disk) {
            if (diskFreeEl) diskFreeEl.textContent = `${json.disk.free_gb} GB`;
            if (diskSubEl) diskSubEl.textContent = `Terpakai: ${json.disk.used_gb} GB dari ${json.disk.total_gb} GB (${json.disk.percent}%)`;
            if (diskFillEl) {
                diskFillEl.style.width = `${json.disk.percent}%`;
                diskFillEl.className = `sidebar-progress-fill ${json.disk.status_color || ''}`;
            }
        }

        // RAM Memory
        if (json.ram) {
            if (ramTextEl) ramTextEl.textContent = `${json.ram.used_gb} / ${json.ram.total_gb} GB (${json.ram.percent}%)`;
            if (ramFillEl) {
                ramFillEl.style.width = `${json.ram.percent}%`;
                ramFillEl.className = `sidebar-progress-fill ram ${json.ram.status_color || ''}`;
            }
        }

        // CPU
        if (json.cpu) {
            if (cpuTextEl) cpuTextEl.textContent = `${json.cpu.percent}%`;
        }

        // Closing & Backup Operations
        if (json.closing_ops) {
            if (backupTextEl) {
                if (json.closing_ops.last_backup) {
                    backupTextEl.textContent = json.closing_ops.last_backup.time_ago;
                    backupTextEl.title = `${json.closing_ops.last_backup.datetime} (${json.closing_ops.last_backup.size_formatted})`;
                } else {
                    backupTextEl.textContent = 'Belum Ada';
                }
            }

            if (conflictPillEl && conflictTextEl) {
                if (json.closing_ops.duplicate_count > 0) {
                    conflictPillEl.style.display = 'inline-flex';
                    conflictTextEl.textContent = `${json.closing_ops.duplicate_count} Tagihan Duplikat!`;
                } else {
                    conflictPillEl.style.display = 'none';
                }
            }
        }

        if (statusBadgeEl) {
            statusBadgeEl.textContent = 'Online';
            statusBadgeEl.className = 'badge badge-success';
        }

        // Populate Modal Diagnostics if open or populated
        updateDiagnosticsModalUI(json);

    } catch (e) {
        console.warn('Gagal memuat server metrics:', e);
        const statusBadgeEl = document.getElementById('sidebar-status-badge');
        if (statusBadgeEl) {
            statusBadgeEl.textContent = 'Offline';
            statusBadgeEl.className = 'badge badge-danger';
        }
    } finally {
        if (showFeedback && btnRefreshDiag) {
            btnRefreshDiag.innerHTML = '<i class="ph ph-arrows-clockwise"></i> Perbarui';
            btnRefreshDiag.disabled = false;
        }
    }
}

function updateDiagnosticsModalUI(json) {
    if (!json) return;

    // Database
    const diagDbHost = document.getElementById('diag-db-host');
    const diagDbEnv = document.getElementById('diag-db-env');
    const diagDbName = document.getElementById('diag-db-name');
    const diagDbSize = document.getElementById('diag-db-size');
    const diagDbPing = document.getElementById('diag-db-ping');
    const diagDbThreads = document.getElementById('diag-db-threads');

    if (json.database) {
        if (diagDbHost) diagDbHost.textContent = `${json.database.host}:${json.database.port}`;
        if (diagDbEnv) {
            diagDbEnv.textContent = json.database.env_type || 'Development';
            diagDbEnv.className = `diag-sub-badge ${json.database.env_type === 'Production' ? 'badge-prod' : 'badge-dev'}`;
        }
        if (diagDbName) diagDbName.textContent = json.database.name;
        if (diagDbSize) diagDbSize.textContent = `${json.database.size_formatted} (Uptime: ${json.database.uptime_hours} Jam)`;
        if (diagDbPing) diagDbPing.innerHTML = `<strong style="color: #34d399;">${json.database.ping_ms} ms</strong>`;
        if (diagDbThreads) diagDbThreads.textContent = `${json.database.threads_connected} Threads Connected`;
    }

    // Closing Ops
    const diagActivePeriod = document.getElementById('diag-active-period');
    const diagActivePeriodFmt = document.getElementById('diag-active-period-fmt');
    const diagLastBackupTime = document.getElementById('diag-last-backup-time');
    const diagLastBackupSize = document.getElementById('diag-last-backup-size');
    const diagConflictVal = document.getElementById('diag-conflict-val');

    if (json.closing_ops) {
        if (diagActivePeriod) diagActivePeriod.textContent = json.closing_ops.active_period || '-';
        if (diagActivePeriodFmt) diagActivePeriodFmt.textContent = json.closing_ops.active_period_formatted || '-';

        if (json.closing_ops.last_backup) {
            if (diagLastBackupTime) diagLastBackupTime.textContent = json.closing_ops.last_backup.datetime;
            if (diagLastBackupSize) diagLastBackupSize.textContent = `${json.closing_ops.last_backup.size_formatted} (${json.closing_ops.last_backup.time_ago})`;
        } else {
            if (diagLastBackupTime) diagLastBackupTime.textContent = 'Belum Ada Arsip';
            if (diagLastBackupSize) diagLastBackupSize.textContent = 'Harap buat cadangan sebelum closing';
        }

        if (diagConflictVal) {
            if (json.closing_ops.duplicate_count > 0) {
                diagConflictVal.innerHTML = `<span style="color: #ef4444;"><i class="ph ph-warning-octagon"></i> ${json.closing_ops.duplicate_count} Tagihan Ganda</span>`;
            } else {
                diagConflictVal.innerHTML = `<span style="color: #10b981;"><i class="ph ph-check-circle"></i> Bersih (0 Duplikat)</span>`;
            }
        }
    }

    // Disk
    const diagDiskPct = document.getElementById('diag-disk-pct');
    const diagDiskFill = document.getElementById('diag-disk-fill');
    const diagDiskFree = document.getElementById('diag-disk-free');
    const diagDiskTotal = document.getElementById('diag-disk-total');

    if (json.disk) {
        if (diagDiskPct) diagDiskPct.textContent = `${json.disk.percent}%`;
        if (diagDiskFill) {
            diagDiskFill.style.width = `${json.disk.percent}%`;
            diagDiskFill.className = `sidebar-progress-fill ${json.disk.status_color || ''}`;
        }
        if (diagDiskFree) diagDiskFree.textContent = `${json.disk.free_gb} GB`;
        if (diagDiskTotal) diagDiskTotal.textContent = `Total: ${json.disk.total_gb} GB`;
    }

    // RAM
    const diagRamPct = document.getElementById('diag-ram-pct');
    const diagRamFill = document.getElementById('diag-ram-fill');
    const diagRamUsed = document.getElementById('diag-ram-used');
    const diagRamTotal = document.getElementById('diag-ram-total');

    if (json.ram) {
        if (diagRamPct) diagRamPct.textContent = `${json.ram.percent}%`;
        if (diagRamFill) {
            diagRamFill.style.width = `${json.ram.percent}%`;
            diagRamFill.className = `sidebar-progress-fill ram ${json.ram.status_color || ''}`;
        }
        if (diagRamUsed) diagRamUsed.textContent = `${json.ram.used_gb} GB`;
        if (diagRamTotal) diagRamTotal.textContent = `Total: ${json.ram.total_gb} GB`;
    }

    // CPU, Network, OS
    const diagCpuVal = document.getElementById('diag-cpu-val');
    const diagCpuLoad = document.getElementById('diag-cpu-load');
    const diagNetRx = document.getElementById('diag-net-rx');
    const diagNetTx = document.getElementById('diag-net-tx');
    const diagPhpVersion = document.getElementById('diag-php-version');
    const diagServerOs = document.getElementById('diag-server-os');
    const diagLastSync = document.getElementById('diag-last-sync');

    if (json.cpu) {
        if (diagCpuVal) diagCpuVal.textContent = `${json.cpu.cores} Cores (${json.cpu.percent}%)`;
        if (diagCpuLoad) diagCpuLoad.textContent = `Load: ${json.cpu.load_1m}, ${json.cpu.load_5m}, ${json.cpu.load_15m}`;
    }

    if (json.network) {
        if (diagNetRx) diagNetRx.textContent = `RX: ${json.network.rx_formatted}`;
        if (diagNetTx) diagNetTx.textContent = `TX: ${json.network.tx_formatted}`;
    }

    if (json.server_env) {
        if (diagPhpVersion) diagPhpVersion.textContent = `PHP ${json.server_env.php_version}`;
        if (diagServerOs) diagServerOs.textContent = `${json.server_env.os}`;
    }

    if (diagLastSync) diagLastSync.textContent = json.server_time || '-';
}

// ==========================================================================
// Server Switcher Handlers & Modal Interactions
// ==========================================================================
let currentActiveServerKey = 'simpam';

function updateServerSwitcherUI(activeKey) {
    currentActiveServerKey = activeKey;

    const btnSimpam = document.getElementById('btn-switch-simpam');
    const btnSimpadu = document.getElementById('btn-switch-simpadu');
    const cardSimpam = document.getElementById('diag-card-simpam');
    const cardSimpadu = document.getElementById('diag-card-simpadu');
    const btnDiagSimpam = document.getElementById('btn-diag-switch-simpam');
    const btnDiagSimpadu = document.getElementById('btn-diag-switch-simpadu');

    if (activeKey === 'simpadu') {
        if (btnSimpam) btnSimpam.classList.remove('active');
        if (btnSimpadu) btnSimpadu.classList.add('active');

        if (cardSimpam) cardSimpam.classList.remove('active');
        if (cardSimpadu) cardSimpadu.classList.add('active');

        if (btnDiagSimpam) {
            btnDiagSimpam.className = 'btn btn-sm btn-server-target';
            btnDiagSimpam.innerHTML = '<i class="ph ph-arrow-right"></i> Beralih ke SIMPAM';
        }
        if (btnDiagSimpadu) {
            btnDiagSimpadu.className = 'btn btn-sm btn-server-target active';
            btnDiagSimpadu.innerHTML = '<i class="ph ph-check-circle"></i> Server Aktif (Production)';
        }
    } else {
        if (btnSimpam) btnSimpam.classList.add('active');
        if (btnSimpadu) btnSimpadu.classList.remove('active');

        if (cardSimpam) cardSimpam.classList.add('active');
        if (cardSimpadu) cardSimpadu.classList.remove('active');

        if (btnDiagSimpam) {
            btnDiagSimpam.className = 'btn btn-sm btn-server-target active';
            btnDiagSimpam.innerHTML = '<i class="ph ph-check-circle"></i> Server Aktif (Development)';
        }
        if (btnDiagSimpadu) {
            btnDiagSimpadu.className = 'btn btn-sm btn-server-target';
            btnDiagSimpadu.innerHTML = '<i class="ph ph-arrow-right"></i> Beralih ke SIMPADU';
        }
    }
}

async function executeServerSwitch(targetServer) {
    if (targetServer === currentActiveServerKey) {
        return;
    }

    if (targetServer === 'simpadu') {
        const ok = confirm("⚠️ PERINGATAN: BERALIH KE DATABASE LIVE PRODUCTION!\n\n" +
            "Anda akan menghubungkan aplikasi Sistem Closing ke Server SIMPADU (192.168.8.11).\n" +
            "Semua proses baca data, estimasi, dan eksekusi closing akan langsung berjalan pada database live produksi.\n\n" +
            "Apakah Anda yakin ingin beralih ke Server SIMPADU?");
        if (!ok) return;
    } else {
        const ok = confirm("Beralih ke Server SIMPAM (192.168.0.10) - Development Server?\n\nAplikasi akan terhubung kembali ke lingkungan database pengujian/development.");
        if (!ok) return;
    }

    const btnDiagSimpam = document.getElementById('btn-diag-switch-simpam');
    const btnDiagSimpadu = document.getElementById('btn-diag-switch-simpadu');
    const clickedDiagBtn = targetServer === 'simpadu' ? btnDiagSimpadu : btnDiagSimpam;

    if (clickedDiagBtn) {
        clickedDiagBtn.innerHTML = '<i class="ph ph-spinner-gap ph-spin"></i> Menghubungkan...';
        clickedDiagBtn.disabled = true;
    }

    try {
        const formData = new FormData();
        formData.append('target', targetServer);

        const res = await fetch('api.php?action=switch_db_server', {
            method: 'POST',
            body: formData
        });

        const json = await res.json();
        if (!res.ok || json.status !== 'success') {
            throw new Error(json.message || 'Gagal mengubah konfigurasi database');
        }

        currentActiveServerKey = targetServer;

        // Reload metrics
        await loadServerMetrics(true);

        // Reload current tab data
        if (typeof loadData === 'function') {
            loadData(false);
        }
        if (typeof loadPipelineLogs === 'function') {
            loadPipelineLogs();
        }
        if (typeof loadBackupData === 'function') {
            loadBackupData();
        }

        alert(`✅ ${json.message}\nSemua modul Sistem Closing kini aktif terhubung ke ${json.label}.`);

    } catch (e) {
        alert(`❌ Gagal Beralih Server Database:\n${e.message}`);
    } finally {
        if (clickedDiagBtn) clickedDiagBtn.disabled = false;
        updateServerSwitcherUI(currentActiveServerKey);
    }
}

// Modal Diagnostics Handlers
const modalDiagnostics = document.getElementById('modal-server-diagnostics');
const btnCloseDiagModal = document.getElementById('btn-close-diag-modal');
const btnCloseDiagAction = document.getElementById('btn-close-diag-action');
const btnRefreshDiag = document.getElementById('btn-refresh-diag');
const sidebarServerMonitor = document.getElementById('sidebar-server-monitor');
const topbarServerSwitcher = document.getElementById('topbar-server-switcher');

function openDiagnosticsModal() {
    if (modalDiagnostics) {
        modalDiagnostics.style.display = 'flex';
        loadServerMetrics();
    }
}

function closeDiagnosticsModal() {
    if (modalDiagnostics) {
        modalDiagnostics.style.display = 'none';
    }
}

if (sidebarServerMonitor) {
    sidebarServerMonitor.addEventListener('click', openDiagnosticsModal);
}
if (btnCloseDiagModal) {
    btnCloseDiagModal.addEventListener('click', closeDiagnosticsModal);
}
if (btnCloseDiagAction) {
    btnCloseDiagAction.addEventListener('click', closeDiagnosticsModal);
}
if (btnRefreshDiag) {
    btnRefreshDiag.addEventListener('click', () => loadServerMetrics(true));
}
if (modalDiagnostics) {
    modalDiagnostics.addEventListener('click', (e) => {
        if (e.target === modalDiagnostics) {
            closeDiagnosticsModal();
        }
    });
}

// Switcher Button Listeners
const btnSwitchSimpam = document.getElementById('btn-switch-simpam');
const btnSwitchSimpadu = document.getElementById('btn-switch-simpadu');
const btnDiagSwitchSimpam = document.getElementById('btn-diag-switch-simpam');
const btnDiagSwitchSimpadu = document.getElementById('btn-diag-switch-simpadu');

if (btnSwitchSimpam) {
    btnSwitchSimpam.addEventListener('click', (e) => {
        e.stopPropagation();
        executeServerSwitch('simpam');
    });
}
if (btnSwitchSimpadu) {
    btnSwitchSimpadu.addEventListener('click', (e) => {
        e.stopPropagation();
        executeServerSwitch('simpadu');
    });
}
if (btnDiagSwitchSimpam) {
    btnDiagSwitchSimpam.addEventListener('click', (e) => {
        e.stopPropagation();
        executeServerSwitch('simpam');
    });
}
if (btnDiagSwitchSimpadu) {
    btnDiagSwitchSimpadu.addEventListener('click', (e) => {
        e.stopPropagation();
        executeServerSwitch('simpadu');
    });
}

// Inisialisasi Server Metrics Poller
loadServerMetrics();
if (!serverMetricsPoller) {
    serverMetricsPoller = setInterval(loadServerMetrics, 15000);
}

// ====================================================================
// AUDIT & VALIDASI PRA-CLOSING MODULE
// ====================================================================
let auditSummaryData = null;
let uncontrolledCurrentPage = 1;
let uncontrolledTotalPages = 1;
let uncontrolledFiltersLoaded = false;
let currentAuditSubtab = 'uncontrolled';

// Subtab Navigation Switcher
function switchAuditSubtab(subtabId) {
    currentAuditSubtab = subtabId;
    
    // Toggle active class on buttons
    document.querySelectorAll('[data-audit-tab]').forEach(btn => {
        if (btn.getAttribute('data-audit-tab') === subtabId) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });

    // Toggle panels
    const panelUncontrolled = document.getElementById('audit-subpanel-uncontrolled');
    const panelTagihan = document.getElementById('audit-subpanel-tagihan');
    const panelAngsuran = document.getElementById('audit-subpanel-angsuran');

    if (panelUncontrolled) panelUncontrolled.style.display = (subtabId === 'uncontrolled') ? 'block' : 'none';
    if (panelTagihan) panelTagihan.style.display = (subtabId === 'tagihan') ? 'block' : 'none';
    if (panelAngsuran) panelAngsuran.style.display = (subtabId === 'angsuran') ? 'block' : 'none';
}

// Load Audit Summary
async function loadAuditSummary() {
    try {
        const res = await fetch('api.php?action=get_audit_summary');
        const json = await res.json();
        
        if (json.status === 'success') {
            auditSummaryData = json;
            const metrics = json.metrics || {};
            const kesiapan = json.kesiapan || {};

            // Update KPI numbers
            const elUncontrolled = document.getElementById('audit-stat-uncontrolled');
            const elTagrek = document.getElementById('audit-stat-tagrek-dup');
            const elTunggak = document.getElementById('audit-stat-tunggak-dup');
            const elAngsuran = document.getElementById('audit-stat-angsuran-dup');

            if (elUncontrolled) elUncontrolled.textContent = (metrics.rekening_belum_kontrol || 0).toLocaleString('id-ID');
            if (elTagrek) elTagrek.textContent = (metrics.tagrek_duplikat || 0).toLocaleString('id-ID');
            if (elTunggak) elTunggak.textContent = ((metrics.tunggak_duplikat || 0) + (metrics.silang_duplikat || 0)).toLocaleString('id-ID');
            if (elAngsuran) elAngsuran.textContent = (metrics.angsuran_duplikat || 0).toLocaleString('id-ID');

            // Update sub-labels
            const subUncontrolled = document.getElementById('audit-sub-uncontrolled');
            if (subUncontrolled) {
                const pct = metrics.rekening_total > 0 ? ((metrics.rekening_belum_kontrol / metrics.rekening_total) * 100).toFixed(1) : 0;
                subUncontrolled.textContent = `${pct}% dari ${metrics.rekening_total.toLocaleString('id-ID')} rekening aktif`;
            }

            // Update subtab badges
            const badgeTabUncontrolled = document.getElementById('subtab-badge-uncontrolled');
            const badgeTabTagihan = document.getElementById('subtab-badge-tagihan');
            const badgeTabAngsuran = document.getElementById('subtab-badge-angsuran');

            if (badgeTabUncontrolled) {
                badgeTabUncontrolled.textContent = (metrics.rekening_belum_kontrol || 0).toLocaleString('id-ID');
                badgeTabUncontrolled.className = `badge ${metrics.rekening_belum_kontrol > 0 ? 'badge-warning' : 'badge-success'}`;
            }
            if (badgeTabTagihan) {
                const totTagihanDup = (metrics.tagrek_duplikat || 0) + (metrics.tunggak_duplikat || 0) + (metrics.silang_duplikat || 0);
                badgeTabTagihan.textContent = totTagihanDup.toLocaleString('id-ID');
                badgeTabTagihan.className = `badge ${totTagihanDup > 0 ? 'badge-danger' : 'badge-success'}`;
            }
            if (badgeTabAngsuran) {
                badgeTabAngsuran.textContent = (metrics.angsuran_duplikat || 0).toLocaleString('id-ID');
                badgeTabAngsuran.className = `badge ${metrics.angsuran_duplikat > 0 ? 'badge-danger' : 'badge-success'}`;
            }

            // Update Overall Status Badge
            const overallBadge = document.getElementById('audit-overall-status-badge');
            if (overallBadge) {
                if (kesiapan.status_keseluruhan === 'SIAP') {
                    overallBadge.className = 'badge badge-success';
                    overallBadge.innerHTML = '<i class="ph ph-shield-check"></i> Siap Closing (Data Bersih)';
                } else {
                    const totalIssues = (metrics.rekening_belum_kontrol || 0) + (metrics.tagrek_duplikat || 0) + (metrics.tunggak_duplikat || 0) + (metrics.angsuran_duplikat || 0);
                    overallBadge.className = 'badge badge-warning';
                    overallBadge.innerHTML = `<i class="ph ph-warning"></i> Perlu Perhatian (${totalIssues} Anomali)`;
                }
            }
        }
    } catch (e) {
        console.error('Error loading audit summary:', e);
    }
}

// Load Uncontrolled Rekening Table
async function loadUncontrolledRekening(page = 1) {
    uncontrolledCurrentPage = page;
    const tbody = document.getElementById('tbody-uncontrolled-rekening');
    const searchVal = document.getElementById('filter-uncontrolled-search')?.value.trim() || '';
    const lokbayVal = document.getElementById('filter-uncontrolled-lokbay')?.value || '';
    const stgolVal = document.getElementById('filter-uncontrolled-stgol')?.value || '';

    if (tbody) {
        tbody.innerHTML = `
            <tr>
                <td colspan="10" style="text-align: center; color: var(--text-secondary); padding: 2rem;">
                    <i class="ph ph-spinner spinner" style="font-size: 1.5rem; color: #38bdf8; display: block; margin: 0 auto 0.5rem;"></i>
                    Memuat data rekening belum dikontrol (Halaman ${page})...
                </td>
            </tr>
        `;
    }

    try {
        const queryParams = new URLSearchParams({
            action: 'get_uncontrolled_rekening',
            page: page,
            limit: 50,
            search: searchVal,
            lokbay: lokbayVal,
            stgol: stgolVal
        });

        const res = await fetch(`api.php?${queryParams.toString()}`);
        const json = await res.json();

        if (json.status === 'success') {
            uncontrolledTotalPages = json.total_pages || 1;
            
            // Populate select options if not populated
            if (!uncontrolledFiltersLoaded && json.filters) {
                const lokbaySelect = document.getElementById('filter-uncontrolled-lokbay');
                const stgolSelect = document.getElementById('filter-uncontrolled-stgol');
                
                if (lokbaySelect && json.filters.lokbay) {
                    json.filters.lokbay.forEach(opt => {
                        const el = document.createElement('option');
                        el.value = opt.ID;
                        el.textContent = `${opt.ID} - ${opt.NAMA}`;
                        lokbaySelect.appendChild(el);
                    });
                }
                if (stgolSelect && json.filters.stgol) {
                    json.filters.stgol.forEach(opt => {
                        const el = document.createElement('option');
                        el.value = opt.ID;
                        el.textContent = `${opt.ID} - ${opt.KETERANGAN}`;
                        stgolSelect.appendChild(el);
                    });
                }
                uncontrolledFiltersLoaded = true;
            }

            // Render rows
            if (tbody) {
                if (!json.data || json.data.length === 0) {
                    tbody.innerHTML = `
                        <tr>
                            <td colspan="10" style="text-align: center; color: #10b981; padding: 2rem;">
                                <i class="ph ph-check-circle" style="font-size: 1.5rem; display: block; margin: 0 auto 0.5rem;"></i>
                                Seluruh rekening pada filter ini telah terkontrol (IS_CTRL = 1).
                            </td>
                        </tr>
                    `;
                } else {
                    tbody.innerHTML = json.data.map(row => {
                        const mtrLalu = parseInt(row.METERLALU || 0);
                        const mtrKini = parseInt(row.METER || row.EDITMETER || 0);
                        const mtrPakai = Math.max(0, mtrKini - mtrLalu);
                        const estTagihan = parseInt(row.ESTIMASI_TAGIHAN || 0);

                        return `
                            <tr>
                                <td><strong style="color: #60a5fa; font-family: monospace;">${row.NO_PDAM}</strong></td>
                                <td><strong style="color: #fff;">${row.NAMA || '-'}</strong></td>
                                <td style="color: var(--text-secondary); font-size: 0.78rem; max-width: 200px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${row.ALAMAT || ''}">${row.ALAMAT || '-'}</td>
                                <td><span class="badge badge-secondary">${row.STGOL_ID || '-'}</span></td>
                                <td><span class="badge badge-secondary">${row.LOKBAY_ID || '-'}</span></td>
                                <td style="text-align: right; font-family: monospace;">${mtrLalu.toLocaleString('id-ID')}</td>
                                <td style="text-align: right; font-family: monospace; color: #38bdf8;">${mtrKini.toLocaleString('id-ID')}</td>
                                <td style="text-align: right; font-family: monospace; font-weight: 600;">${mtrPakai.toLocaleString('id-ID')}</td>
                                <td style="text-align: right; font-family: monospace; color: #34d399; font-weight: 600;">Rp ${estTagihan.toLocaleString('id-ID')}</td>
                                <td style="text-align: center;">
                                    <span class="badge badge-warning" style="font-size: 0.7rem; padding: 2px 6px;">
                                        <i class="ph ph-clock"></i> Belum Ctrl
                                    </span>
                                </td>
                            </tr>
                        `;
                    }).join('');
                }
            }

            // Update Pagination UI
            const pageInfo = document.getElementById('uncontrolled-page-info');
            const curPageEl = document.getElementById('uncontrolled-current-page');
            const btnPrev = document.getElementById('btn-uncontrolled-prev');
            const btnNext = document.getElementById('btn-uncontrolled-next');

            const startIdx = json.total > 0 ? (page - 1) * json.limit + 1 : 0;
            const endIdx = Math.min(page * json.limit, json.total);

            if (pageInfo) pageInfo.textContent = `Menampilkan ${startIdx}-${endIdx} dari ${json.total.toLocaleString('id-ID')} data`;
            if (curPageEl) curPageEl.textContent = `${page} / ${json.total_pages || 1}`;
            if (btnPrev) btnPrev.disabled = (page <= 1);
            if (btnNext) btnNext.disabled = (page >= json.total_pages);
        }
    } catch (e) {
        console.error('Error loading uncontrolled rekening:', e);
        if (tbody) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="10" style="text-align: center; color: #ef4444; padding: 2rem;">
                        Gagal memuat data: ${e.message}
                    </td>
                </tr>
            `;
        }
    }
}

// Load Tagihan Duplicates (spd_tagrek, spd_tunggak, cross-check)
async function loadTagihanDuplicates() {
    const tbodyTagrek = document.getElementById('tbody-tagrek-duplicates');
    const tbodyTunggak = document.getElementById('tbody-tunggak-duplicates');
    const tbodySilang = document.getElementById('tbody-silang-duplicates');

    try {
        const res = await fetch('api.php?action=get_tagihan_duplicates');
        const json = await res.json();

        if (json.status === 'success' && json.data) {
            const data = json.data;

            // 1. Tagrek Duplicates
            const badgeTagrek = document.getElementById('badge-count-tagrek-dup');
            if (badgeTagrek) badgeTagrek.textContent = `${(data.tagrek_duplicates || []).length} Duplikat`;
            if (tbodyTagrek) {
                if (!data.tagrek_duplicates || data.tagrek_duplicates.length === 0) {
                    tbodyTagrek.innerHTML = `
                        <tr>
                            <td colspan="7" style="text-align: center; color: #10b981; padding: 1.5rem;">
                                <i class="ph ph-check-circle" style="font-size: 1.2rem; vertical-align: middle;"></i> Tidak ditemukan duplikasi di spd_tagrek (Bersih).
                            </td>
                        </tr>
                    `;
                } else {
                    tbodyTagrek.innerHTML = data.tagrek_duplicates.map(row => `
                        <tr>
                            <td><strong style="color: #c084fc; font-family: monospace;">${row.NO_PDAM}</strong></td>
                            <td><strong style="color: #fff;">${row.NAMA || '-'}</strong></td>
                            <td style="color: var(--text-secondary); font-size: 0.78rem;">${row.ALAMAT || '-'}</td>
                            <td><span class="badge badge-secondary">${row.REKENING_BULAN || '-'}</span></td>
                            <td style="text-align: center;"><span class="badge badge-danger">${row.jml_kembar} Baris</span></td>
                            <td style="text-align: right; font-family: monospace; color: #f87171; font-weight: 600;">Rp ${parseInt(row.tot_tagihan || 0).toLocaleString('id-ID')}</td>
                            <td style="font-family: monospace; font-size: 0.75rem; color: #94a3b8;">${row.ids || '-'}</td>
                        </tr>
                    `).join('');
                }
            }

            // 2. Tunggak Duplicates
            const badgeTunggak = document.getElementById('badge-count-tunggak-dup');
            if (badgeTunggak) badgeTunggak.textContent = `${(data.tunggak_duplicates || []).length} Duplikat`;
            if (tbodyTunggak) {
                if (!data.tunggak_duplicates || data.tunggak_duplicates.length === 0) {
                    tbodyTunggak.innerHTML = `
                        <tr>
                            <td colspan="7" style="text-align: center; color: #10b981; padding: 1.5rem;">
                                <i class="ph ph-check-circle" style="font-size: 1.2rem; vertical-align: middle;"></i> Tidak ditemukan duplikasi di spd_tunggak (Bersih).
                            </td>
                        </tr>
                    `;
                } else {
                    tbodyTunggak.innerHTML = data.tunggak_duplicates.map(row => `
                        <tr>
                            <td><strong style="color: #f87171; font-family: monospace;">${row.NO_PDAM}</strong></td>
                            <td><strong style="color: #fff;">${row.NAMA || '-'}</strong></td>
                            <td style="color: var(--text-secondary); font-size: 0.78rem;">${row.ALAMAT || '-'}</td>
                            <td><span class="badge badge-secondary">${row.periode || '-'}</span></td>
                            <td style="text-align: center;"><span class="badge badge-danger">${row.jml_kembar} Baris</span></td>
                            <td style="text-align: right; font-family: monospace; color: #f87171; font-weight: 600;">Rp ${parseInt(row.tot_tunggak || 0).toLocaleString('id-ID')}</td>
                            <td style="font-family: monospace; font-size: 0.75rem; color: #94a3b8;">${row.ids || '-'}</td>
                        </tr>
                    `).join('');
                }
            }

            // 3. Silang Duplicates
            const badgeSilang = document.getElementById('badge-count-silang-dup');
            if (badgeSilang) badgeSilang.textContent = `${(data.silang_duplicates || []).length} Konflik`;
            if (tbodySilang) {
                if (!data.silang_duplicates || data.silang_duplicates.length === 0) {
                    tbodySilang.innerHTML = `
                        <tr>
                            <td colspan="7" style="text-align: center; color: #10b981; padding: 1.5rem;">
                                <i class="ph ph-check-circle" style="font-size: 1.2rem; vertical-align: middle;"></i> Tidak ada konflik silang antara spd_tagrek dan spd_tunggak (Bersih).
                            </td>
                        </tr>
                    `;
                } else {
                    tbodySilang.innerHTML = data.silang_duplicates.map(row => `
                        <tr>
                            <td><strong style="color: #fbbf24; font-family: monospace;">${row.NO_PDAM}</strong></td>
                            <td><strong style="color: #fff;">${row.NAMA || '-'}</strong></td>
                            <td><span class="badge badge-secondary">${row.periode || '-'}</span></td>
                            <td style="text-align: right; font-family: monospace; color: #60a5fa;">Rp ${parseInt(row.tagihan_tagrek || 0).toLocaleString('id-ID')}</td>
                            <td style="text-align: right; font-family: monospace; color: #f87171;">Rp ${parseInt(row.tagihan_tunggak || 0).toLocaleString('id-ID')}</td>
                            <td style="font-family: monospace; font-size: 0.75rem; color: #94a3b8;">${row.id_tagrek || '-'}</td>
                            <td style="font-family: monospace; font-size: 0.75rem; color: #94a3b8;">${row.id_tunggak || '-'}</td>
                        </tr>
                    `).join('');
                }
            }
        }
    } catch (e) {
        console.error('Error loading tagihan duplicates:', e);
    }
}

// Load Angsuran Duplicates (spd_angsuran, spd_rekang)
async function loadAngsuranDuplicates() {
    const tbodyAngsuran = document.getElementById('tbody-angsuran-duplicates');
    const tbodyRekang = document.getElementById('tbody-rekang-duplicates');

    try {
        const res = await fetch('api.php?action=get_angsuran_duplicates');
        const json = await res.json();

        if (json.status === 'success' && json.data) {
            const data = json.data;

            // 1. Master Angsuran Duplicates
            const badgeAngsuran = document.getElementById('badge-count-angsuran-dup');
            if (badgeAngsuran) badgeAngsuran.textContent = `${(data.angsuran_duplicates || []).length} Duplikat`;
            if (tbodyAngsuran) {
                if (!data.angsuran_duplicates || data.angsuran_duplicates.length === 0) {
                    tbodyAngsuran.innerHTML = `
                        <tr>
                            <td colspan="8" style="text-align: center; color: #10b981; padding: 1.5rem;">
                                <i class="ph ph-check-circle" style="font-size: 1.2rem; vertical-align: middle;"></i> Tidak ditemukan duplikasi di master spd_angsuran (Bersih).
                            </td>
                        </tr>
                    `;
                } else {
                    tbodyAngsuran.innerHTML = data.angsuran_duplicates.map(row => `
                        <tr>
                            <td><strong style="color: #38bdf8; font-family: monospace;">${row.NO_PDAM}</strong></td>
                            <td><strong style="color: #fff;">${row.NAMA || '-'}</strong></td>
                            <td><span class="badge badge-secondary">${row.KRITERIA || '-'}</span></td>
                            <td><span class="badge badge-secondary">${row.PERIODE || '-'}</span></td>
                            <td style="text-align: center;"><span class="badge badge-danger">${row.jml_kembar} Master</span></td>
                            <td style="text-align: right; font-family: monospace;">Rp ${parseInt(row.tot_volume || 0).toLocaleString('id-ID')}</td>
                            <td style="text-align: right; font-family: monospace; color: #34d399;">Rp ${parseInt(row.tot_akumbayar || 0).toLocaleString('id-ID')}</td>
                            <td style="font-family: monospace; font-size: 0.75rem; color: #94a3b8;">${row.ids || '-'}</td>
                        </tr>
                    `).join('');
                }
            }

            // 2. Rekang Duplicates
            const badgeRekang = document.getElementById('badge-count-rekang-dup');
            if (badgeRekang) badgeRekang.textContent = `${(data.rekang_duplicates || []).length} Duplikat`;
            if (tbodyRekang) {
                if (!data.rekang_duplicates || data.rekang_duplicates.length === 0) {
                    tbodyRekang.innerHTML = `
                        <tr>
                            <td colspan="7" style="text-align: center; color: #10b981; padding: 1.5rem;">
                                <i class="ph ph-check-circle" style="font-size: 1.2rem; vertical-align: middle;"></i> Tidak ditemukan duplikasi di spd_rekang (Bersih).
                            </td>
                        </tr>
                    `;
                } else {
                    tbodyRekang.innerHTML = data.rekang_duplicates.map(row => `
                        <tr>
                            <td><strong style="color: #a5b4fc; font-family: monospace;">${row.NO_PDAM}</strong></td>
                            <td><strong style="color: #fff;">${row.NAMA || '-'}</strong></td>
                            <td><span class="badge badge-secondary">${row.TANGGAL || '-'}</span></td>
                            <td><span class="badge badge-secondary">${row.KRITERIA || '-'}</span></td>
                            <td style="text-align: center;"><span class="badge badge-danger">${row.jml_kembar} Baris</span></td>
                            <td style="text-align: right; font-family: monospace; color: #f87171; font-weight: 600;">Rp ${parseInt(row.tot_angplan || 0).toLocaleString('id-ID')}</td>
                            <td style="font-family: monospace; font-size: 0.75rem; color: #94a3b8;">${row.ids || '-'}</td>
                        </tr>
                    `).join('');
                }
            }
        }
    } catch (e) {
        console.error('Error loading angsuran duplicates:', e);
    }
}

// Export Uncontrolled to CSV
async function exportUncontrolledCSV() {
    try {
        const searchVal = document.getElementById('filter-uncontrolled-search')?.value.trim() || '';
        const lokbayVal = document.getElementById('filter-uncontrolled-lokbay')?.value || '';
        const stgolVal = document.getElementById('filter-uncontrolled-stgol')?.value || '';

        const queryParams = new URLSearchParams({
            action: 'get_uncontrolled_rekening',
            page: 1,
            limit: 5000,
            search: searchVal,
            lokbay: lokbayVal,
            stgol: stgolVal
        });

        const res = await fetch(`api.php?${queryParams.toString()}`);
        const json = await res.json();

        if (json.status === 'success' && json.data) {
            const rows = json.data;
            if (rows.length === 0) {
                showNotification('Export CSV', 'Tidak ada data rekening belum kontrol untuk diunduh.', 'warning');
                return;
            }

            let csvContent = "NO_PDAM,NAMA,ALAMAT,GOLONGAN,LOKASI_BAYAR,METER_LALU,METER_KINI,METER_PAKAI,ESTIMASI_TAGIHAN\n";
            rows.forEach(r => {
                const mtrLalu = parseInt(r.METERLALU || 0);
                const mtrKini = parseInt(r.METER || r.EDITMETER || 0);
                const mtrPakai = Math.max(0, mtrKini - mtrLalu);
                const estTagihan = parseInt(r.ESTIMASI_TAGIHAN || 0);
                
                const namaClean = (r.NAMA || '').replace(/"/g, '""');
                const alamatClean = (r.ALAMAT || '').replace(/"/g, '""');

                csvContent += `"${r.NO_PDAM}","${namaClean}","${alamatClean}","${r.STGOL_ID}","${r.LOKBAY_ID}",${mtrLalu},${mtrKini},${mtrPakai},${estTagihan}\n`;
            });

            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `rekening_belum_kontrol_${json.periode || 'aktif'}.csv`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            showNotification('Export Berhasil', `Berhasil mengunduh ${rows.length} baris data ke format CSV.`, 'success');
        }
    } catch (e) {
        showNotification('Gagal Export', 'Terjadi kesalahan saat mengekspor data: ' + e.message, 'error');
    }
}

// Wire Audit Event Listeners
document.addEventListener('DOMContentLoaded', () => {
    // Subtab pills
    document.querySelectorAll('[data-audit-tab]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const tab = e.currentTarget.getAttribute('data-audit-tab');
            switchAuditSubtab(tab);
        });
    });

    // KPI card clicks jump to respective sub-tab
    document.getElementById('card-kpi-uncontrolled')?.addEventListener('click', () => switchAuditSubtab('uncontrolled'));
    document.getElementById('card-kpi-tagrek')?.addEventListener('click', () => switchAuditSubtab('tagihan'));
    document.getElementById('card-kpi-tunggak')?.addEventListener('click', () => switchAuditSubtab('tagihan'));
    document.getElementById('card-kpi-angsuran')?.addEventListener('click', () => switchAuditSubtab('angsuran'));

    // Refresh buttons
    document.getElementById('btn-refresh-audit')?.addEventListener('click', () => {
        loadAuditSummary();
        loadUncontrolledRekening(uncontrolledCurrentPage);
        loadTagihanDuplicates();
        loadAngsuranDuplicates();
        showNotification('Audit Diperbarui', 'Data validasi pra-closing telah disinkronkan.', 'info');
    });

    document.getElementById('btn-reload-uncontrolled')?.addEventListener('click', () => {
        loadUncontrolledRekening(uncontrolledCurrentPage);
    });

    // Filter controls for uncontrolled
    document.getElementById('btn-apply-uncontrolled-filter')?.addEventListener('click', () => {
        loadUncontrolledRekening(1);
    });

    document.getElementById('filter-uncontrolled-search')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') loadUncontrolledRekening(1);
    });

    document.getElementById('filter-uncontrolled-lokbay')?.addEventListener('change', () => loadUncontrolledRekening(1));
    document.getElementById('filter-uncontrolled-stgol')?.addEventListener('change', () => loadUncontrolledRekening(1));

    document.getElementById('btn-reset-uncontrolled-filter')?.addEventListener('click', () => {
        const s = document.getElementById('filter-uncontrolled-search');
        const l = document.getElementById('filter-uncontrolled-lokbay');
        const g = document.getElementById('filter-uncontrolled-stgol');
        if (s) s.value = '';
        if (l) l.value = '';
        if (g) g.value = '';
        loadUncontrolledRekening(1);
    });

    // Pagination buttons for uncontrolled
    document.getElementById('btn-uncontrolled-prev')?.addEventListener('click', () => {
        if (uncontrolledCurrentPage > 1) {
            loadUncontrolledRekening(uncontrolledCurrentPage - 1);
        }
    });

    document.getElementById('btn-uncontrolled-next')?.addEventListener('click', () => {
        if (uncontrolledCurrentPage < uncontrolledTotalPages) {
            loadUncontrolledRekening(uncontrolledCurrentPage + 1);
        }
    });

    // Export CSV
    document.getElementById('btn-export-uncontrolled-csv')?.addEventListener('click', exportUncontrolledCSV);
});

// ====================================================================
// AUTHENTICATION & SESSION MANAGEMENT MODULE
// ====================================================================
const loginOverlay = document.getElementById('login-overlay');
const formLoginAuth = document.getElementById('form-login-auth');
const tabLoginPassword = document.getElementById('tab-login-password');
const tabLoginPin = document.getElementById('tab-login-pin');
const sectionLoginPassword = document.getElementById('section-login-password');
const sectionLoginPin = document.getElementById('section-login-pin');
const inputLoginUsername = document.getElementById('login-username');
const inputLoginPassword = document.getElementById('login-password');
const inputLoginPin = document.getElementById('login-pin');
const inputLoginRemember = document.getElementById('login-remember-me');
const btnToggleLoginPwd = document.getElementById('btn-toggle-login-pwd');
const iconTogglePwd = document.getElementById('icon-toggle-pwd');
const loginAlert = document.getElementById('login-alert');
const loginAlertText = document.getElementById('login-alert-text');
const btnLoginSubmit = document.getElementById('btn-login-submit');
const btnLoginText = document.getElementById('btn-login-text');
const loginSubmitLoader = document.getElementById('login-submit-loader');

const sidebarUserName = document.getElementById('sidebar-user-name');
const sidebarUserRole = document.getElementById('sidebar-user-role');
const sidebarUserAvatar = document.getElementById('sidebar-user-avatar');
const btnSidebarLogout = document.getElementById('btn-sidebar-logout');
const topbarSessionPill = document.getElementById('topbar-session-pill');
const topbarSessionText = document.getElementById('topbar-session-text');

let currentAuthType = 'password';
let sessionInterval = null;
let remainingSessionSeconds = 3600;

function showLoginOverlay(message = null) {
    if (loginOverlay) {
        loginOverlay.style.display = 'flex';
    }
    if (message && loginAlert && loginAlertText) {
        loginAlert.style.display = 'flex';
        loginAlertText.textContent = message;
    }
    if (currentAuthType === 'password') {
        if (inputLoginPassword) inputLoginPassword.focus();
    } else {
        if (inputLoginPin) inputLoginPin.focus();
    }
}

function hideLoginOverlay() {
    if (loginOverlay) {
        loginOverlay.style.display = 'none';
    }
    if (loginAlert) {
        loginAlert.style.display = 'none';
    }
}

function updateSessionUI(user, remainingSeconds = 3600) {
    if (user) {
        if (sidebarUserName) sidebarUserName.textContent = user.username || 'Admin';
        if (sidebarUserRole) sidebarUserRole.textContent = user.role || 'Operator';
        if (sidebarUserAvatar) {
            const firstChar = (user.username || 'A').charAt(0).toUpperCase();
            sidebarUserAvatar.textContent = firstChar;
        }
    }
    remainingSessionSeconds = remainingSeconds;
    startSessionTimer();
}

function startSessionTimer() {
    if (sessionInterval) clearInterval(sessionInterval);
    sessionInterval = setInterval(() => {
        remainingSessionSeconds = Math.max(0, remainingSessionSeconds - 1);
        const mins = Math.floor(remainingSessionSeconds / 60);
        const secs = remainingSessionSeconds % 60;
        
        if (topbarSessionText) {
            if (mins > 0) {
                topbarSessionText.textContent = `Sesi: ${mins}m`;
            } else {
                topbarSessionText.textContent = `Sesi: ${secs}s`;
            }
        }

        if (remainingSessionSeconds <= 0) {
            clearInterval(sessionInterval);
            sessionInterval = null;
            showLoginOverlay('Sesi Anda telah berakhir. Silakan login kembali untuk melanjutkan.');
        }
    }, 1000);
}

async function checkAuthSession() {
    try {
        const res = await fetch('api.php?action=check_session');
        const json = await res.json();
        if (json.status === 'success' && json.authenticated) {
            hideLoginOverlay();
            updateSessionUI(json.user, json.remaining_seconds || 3600);
        } else {
            showLoginOverlay();
        }
    } catch (e) {
        console.error('Error checking session:', e);
        showLoginOverlay();
    }
}

if (tabLoginPassword && tabLoginPin) {
    tabLoginPassword.addEventListener('click', () => {
        currentAuthType = 'password';
        tabLoginPassword.classList.add('active');
        tabLoginPin.classList.remove('active');
        if (sectionLoginPassword) sectionLoginPassword.style.display = 'block';
        if (sectionLoginPin) sectionLoginPin.style.display = 'none';
        if (inputLoginPassword) inputLoginPassword.focus();
    });

    tabLoginPin.addEventListener('click', () => {
        currentAuthType = 'pin';
        tabLoginPin.classList.add('active');
        tabLoginPassword.classList.remove('active');
        if (sectionLoginPassword) sectionLoginPassword.style.display = 'none';
        if (sectionLoginPin) sectionLoginPin.style.display = 'block';
        if (inputLoginPin) inputLoginPin.focus();
    });
}

if (btnToggleLoginPwd && inputLoginPassword && iconTogglePwd) {
    btnToggleLoginPwd.addEventListener('click', () => {
        if (inputLoginPassword.type === 'password') {
            inputLoginPassword.type = 'text';
            iconTogglePwd.className = 'ph ph-eye-slash';
        } else {
            inputLoginPassword.type = 'password';
            iconTogglePwd.className = 'ph ph-eye';
        }
    });
}

if (formLoginAuth) {
    formLoginAuth.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (loginAlert) loginAlert.style.display = 'none';

        const payload = {
            login_type: currentAuthType,
            username: inputLoginUsername ? inputLoginUsername.value.trim() : '',
            password: inputLoginPassword ? inputLoginPassword.value : '',
            pin: inputLoginPin ? inputLoginPin.value.trim() : '',
            remember_me: inputLoginRemember ? inputLoginRemember.checked : false
        };

        if (currentAuthType === 'pin' && (!payload.pin || payload.pin.length < 4)) {
            if (loginAlert && loginAlertText) {
                loginAlert.style.display = 'flex';
                loginAlertText.textContent = 'Silakan masukkan PIN operator dengan benar.';
            }
            return;
        }

        if (btnLoginSubmit) btnLoginSubmit.disabled = true;
        if (btnLoginText) btnLoginText.style.display = 'none';
        if (loginSubmitLoader) loginSubmitLoader.style.display = 'inline-flex';

        try {
            const res = await fetch('api.php?action=login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const json = await res.json();

            if (json.status === 'success') {
                hideLoginOverlay();
                updateSessionUI(json.user, json.session_timeout_seconds || 3600);
                showNotification('Sukses', json.message || 'Login berhasil!', 'success');
                // Reload dashboard data
                loadData();
                loadAutomationConfig();
                loadPipelineLogs();
                loadServerMetrics();
            } else {
                if (loginAlert && loginAlertText) {
                    loginAlert.style.display = 'flex';
                    loginAlertText.textContent = json.message || 'Kredensial atau PIN salah.';
                }
            }
        } catch (err) {
            if (loginAlert && loginAlertText) {
                loginAlert.style.display = 'flex';
                loginAlertText.textContent = 'Kesalahan jaringan: ' + err.message;
            }
        } finally {
            if (btnLoginSubmit) btnLoginSubmit.disabled = false;
            if (btnLoginText) btnLoginText.style.display = 'inline-flex';
            if (loginSubmitLoader) loginSubmitLoader.style.display = 'none';
        }
    });
}

if (btnSidebarLogout) {
    btnSidebarLogout.addEventListener('click', async () => {
        if (!confirm('Apakah Anda yakin ingin logout dari Sistem Closing?')) {
            return;
        }
        try {
            await fetch('api.php?action=logout');
        } catch (e) {}
        if (sessionInterval) clearInterval(sessionInterval);
        showNotification('Logout', 'Anda telah berhasil keluar dari sistem.', 'info');
        showLoginOverlay('Silakan login kembali untuk mengakses sistem.');
    });
}

if (topbarSessionPill) {
    topbarSessionPill.addEventListener('click', () => {
        checkAuthSession();
        showNotification('Sesi Diperbarui', 'Sesi operasional aktif telah diperbarui.', 'info');
    });
}

// Inisialisasi Cek Autentikasi Sesi
checkAuthSession();


