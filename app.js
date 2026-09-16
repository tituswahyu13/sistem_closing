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

const getQueries = (periode) => {
    const tanggal = getTanggalLike(periode);
    return {
        beli: `SELECT a.*, b.* 
FROM spd_rekening a 
JOIN spd_stlgn b ON b.ID = a.STLGN_ID
WHERE 
    -- 1. Kondisi Data Utama
    a.PERIODE = '${periode}' 
    AND a.STATUS = 'a' 
    AND a.FLAG = '0' 
    AND a.LOKBAY_ID IN ('KB', 'KM', 'KS', 'L') 
    AND a.STGOL_ID IN ('IIA1','IIA2','IIA3','IIIA','IIIB','IVA','IVB')

    -- 2. Hilangkan data dengan b.nama like rumdis, rumdin, rusus
    AND b.nama NOT LIKE '%rumdis%' 
    AND b.nama NOT LIKE '%rumdin%' 
    AND b.nama NOT LIKE '%rusus%'

    -- 3. Hilangkan data yang ada di Data Tunggakan
    AND a.no_pdam NOT IN (
        SELECT no_pdam 
        FROM spd_tunggak c 
        WHERE (c.IS_DELETE = 0 AND c.IS_YKK = 0 AND c.LUNAS = 0)
           OR (c.IS_DELETE = 0 AND c.IS_YKK = 1 AND c.PH = 'P')
    )

    -- 4. Hilangkan data yang ada di Data Penertiban
    AND a.no_pdam NOT IN (
        SELECT no_pdam 
        FROM spd_bon d 
        WHERE d.TANGGAL LIKE '${tanggal}-%' 
          AND d.IS_DELETE = '0' 
          AND d.STPLYN_ID LIKE 't%' 
          AND d.LUNAS = '0'
    )

    -- 5. Hilangkan data yang ada di Data Realisasi
    AND a.no_pdam NOT IN (
        SELECT no_pdam 
        FROM spd_realmohon e 
        WHERE e.TANGGAL LIKE '${tanggal}%' 
          AND e.STPLYN_ID LIKE 't%'
    )

    -- 6. Hilangkan data yang ada di Data Subsidi
    AND a.no_pdam NOT IN (
        SELECT no_pdam 
        FROM spd_rekening f 
        WHERE f.subsidi != 0 
          AND f.FLAG = '0'
    );`,
    batal: `SELECT a.*, b.*,
    CASE
        WHEN a.STATUS != 'a' THEN CONCAT('Status ', UPPER(a.STATUS))
        WHEN LOWER(b.NAMA) LIKE '%rumdis%' THEN 'Rumdis'
        WHEN LOWER(b.NAMA) LIKE '%rumdin%' THEN 'Rumdin'
        WHEN LOWER(b.NAMA) LIKE '%rusus%' THEN 'Rusus'
        WHEN a.no_pdam IN (
            SELECT no_pdam FROM spd_tunggak c 
            WHERE (c.IS_DELETE = 0 AND c.IS_YKK = 0 AND c.LUNAS = 0) OR (c.IS_DELETE = 0 AND c.IS_YKK = 1 AND c.PH = 'P')
        ) THEN 'Tunggakan'
        WHEN a.no_pdam IN (
            SELECT no_pdam FROM spd_bon d 
            WHERE d.TANGGAL LIKE '${tanggal}-%' AND d.IS_DELETE = '0' AND d.STPLYN_ID LIKE 't%' AND d.LUNAS = '0'
        ) THEN 'Penertiban'
        WHEN a.no_pdam IN (
            SELECT no_pdam FROM spd_realmohon e 
            WHERE e.TANGGAL LIKE '${tanggal}%' AND e.STPLYN_ID LIKE 't%'
        ) THEN 'Realisasi'
        WHEN a.no_pdam IN (
            SELECT no_pdam FROM spd_rekening f 
            WHERE f.subsidi != 0 AND f.FLAG = '0'
        ) THEN 'Subsidi'
        ELSE 'Lainnya'
    END AS ALASAN
FROM spd_rekening a 
JOIN spd_stlgn b ON b.ID = a.STLGN_ID
WHERE 
    -- 1. Kriteria Data Utama (Harus Terpenuhi)
    a.PERIODE = '${periode}' 
    AND a.STATUS != 'l' 
    AND a.FLAG = '0' 
    AND a.LOKBAY_ID IN ('KB', 'KM', 'KS', 'L') 
    AND a.STGOL_ID IN ('IIA1','IIA2','IIA3','IIIA','IIIB','IVA','IVB')

    -- 2. Data tereliminasi jika memenuhi SALAH SATU dari kondisi di bawah ini:
    AND (
        -- Status bukan Aktif
        a.STATUS != 'a'
        
        -- ATAU Terkena filter Nama (rumdis, rumdin, rusus)
        OR (b.nama LIKE '%rumdis%' OR b.nama LIKE '%rumdin%' OR b.nama LIKE '%rusus%')
        
        -- ATAU Terkena filter Data Tunggakan
        OR a.no_pdam IN (
            SELECT no_pdam 
            FROM spd_tunggak c 
            WHERE (c.IS_DELETE = 0 AND c.IS_YKK = 0 AND c.LUNAS = 0)
               OR (c.IS_DELETE = 0 AND c.IS_YKK = 1 AND c.PH = 'P')
        )
        
        -- ATAU Terkena filter Data Penertiban
        OR a.no_pdam IN (
            SELECT no_pdam 
            FROM spd_bon d 
            WHERE d.TANGGAL LIKE '${tanggal}-%' 
              AND d.IS_DELETE = '0' 
              AND d.STPLYN_ID LIKE 't%' 
              AND d.LUNAS = '0'
        )
        
        -- ATAU Terkena filter Data Realisasi
        OR a.no_pdam IN (
            SELECT no_pdam 
            FROM spd_realmohon e 
            WHERE e.TANGGAL LIKE '${tanggal}%' 
              AND e.STPLYN_ID LIKE 't%'
        )
        
        -- ATAU Terkena filter Data Subsidi
        OR a.no_pdam IN (
            SELECT no_pdam 
            FROM spd_rekening f 
            WHERE f.subsidi != 0 
              AND f.FLAG = '0'
        )
    );`
    };
};

// DOM Elements
const navItems = document.querySelectorAll('.nav-item');
const pageTitle = document.getElementById('page-title');
const tableBody = document.getElementById('table-body');
const thAlasan = document.getElementById('th-alasan');
const sqlCode = document.getElementById('sql-code');
const btnToggleQuery = document.getElementById('btn-toggle-query');
const queryContent = document.getElementById('query-content');
const statTotal = document.getElementById('stat-total');
const statTotalJumlah = document.getElementById('stat-total-jumlah');
const statTunggakan = document.getElementById('stat-tunggakan');
const statCardAlasan = document.getElementById('stat-card-alasan');
const pageCount = document.getElementById('page-count');
const btnRefresh = document.querySelector('header .icon-btn[title="Refresh Data"]');
const btnLoadData = document.getElementById('btn-load-data');
const searchInput = document.getElementById('search-input');
const btnExport = document.getElementById('btn-export');
const datePicker = document.getElementById('date-picker');
const periodeLabel = document.getElementById('periode-label');

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
    const parts = (datePicker.value || '').split('-');
    if (parts.length === 3) {
        const year = parseInt(parts[0], 10);
        const month = parseInt(parts[1], 10);
        const monthName = namaBulan[month - 1] || '';
        periodeLabel.innerHTML = `Periode: <strong id="periode-code">${periode}</strong> <span style="opacity: 0.8; font-size: 0.75rem; margin-left: 2px;">(${monthName} ${year})</span>`;
    } else {
        periodeLabel.innerHTML = `Periode: <strong id="periode-code">${periode}</strong>`;
    }
    
    // Update SQL Code
    if (sqlCode) {
        sqlCode.textContent = getQueries(periode)[currentTab];
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
    
    if (alasan === 'Tunggakan' || alasan === 'Penertiban') {
        badgeClass = 'badge-danger';
    } else if (alasan === 'Rumdis' || alasan === 'Rumdin' || alasan === 'Rusus') {
        badgeClass = 'badge-warning';
    } else if (alasan === 'Subsidi' || alasan === 'Realisasi') {
        badgeClass = 'badge-success';
    }
    
    return `<span class="badge ${badgeClass}">${alasan}</span>`;
}

// Helper to format currency
const formatRupiah = (angka) => {
    return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(angka);
};

// Fetch Data from API
async function fetchData(type) {
    const progressBar = document.getElementById('table-progress-bar');
    if (progressBar) progressBar.style.display = 'block';

    // Show Loading Animation in Table
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
    
    // Disable Buttons & Update text with spinning icon
    btnLoadData.disabled = true;
    btnLoadData.classList.add('btn-loading');
    btnLoadData.innerHTML = '<i class="ph ph-spinner spinner"></i> Memuat Data...';
    if (btnRefresh) {
        btnRefresh.disabled = true;
        btnRefresh.innerHTML = '<i class="ph ph-spinner spinner"></i>';
    }
    
    const periode = getSelectedPeriode();
    
    try {
        const response = await fetch(`${API_BASE_URL}?action=${type}&periode=${periode}`);
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
        renderTable(data, type);
    } catch (error) {
        console.error('Error fetching data:', error);
        tableBody.innerHTML = `<tr><td colspan="10" style="text-align: center; padding: 2.5rem; color: #ef4444;"><i class="ph ph-warning-circle" style="font-size: 1.5rem; display: block; margin-bottom: 0.5rem;"></i>Gagal mengambil data dari server.<br><small style="color: #94a3b8; font-size: 0.85rem; margin-top: 0.25rem; display: inline-block;">${error.message || 'Pastikan backend dan koneksi database berjalan.'}</small></td></tr>`;
        
        // Reset stats
        statTotal.textContent = '0';
        statTotalJumlah.textContent = 'Rp 0';
        pageCount.textContent = '0';
        statTunggakan.textContent = '0';
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
    
    if (data.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="10" style="text-align: center; padding: 2rem;">Tidak ada data ditemukan.</td></tr>';
    } else {
        data.forEach(row => {
            const tr = document.createElement('tr');
            
            const rk = parseFloat(row.RK) || 0;
            const nonAir = parseFloat(row.NON_AIR) || 0;
            const jumlah = rk + nonAir;
            grandTotal += jumlah;
            
            let html = `
                <td><strong>${row.NO_PDAM}</strong></td>
                <td>${row.NAMA}</td>
                <td>${row.PERIODE}</td>
                <td><span class="badge badge-info">${row.LOKBAY_ID}</span></td>
                <td>${row.STGOL_ID}</td>
            `;
            
            if (type === 'batal') {
                html += `<td>${getAlasanBadge(row.ALASAN)}</td>`;
            }
            
            html += `
                <td style="text-align: right;">${formatRupiah(rk)}</td>
                <td style="text-align: right;">${formatRupiah(nonAir)}</td>
                <td style="text-align: right;" class="text-accent"><strong>${formatRupiah(jumlah)}</strong></td>
                <td>
                    <button class="icon-btn" title="Detail"><i class="ph ph-eye"></i></button>
                </td>
            `;
            
            tr.innerHTML = html;
            tableBody.appendChild(tr);
        });
    }
    
    // Update Stats
    statTotal.textContent = data.length;
    statTotalJumlah.textContent = formatRupiah(grandTotal);
    pageCount.textContent = data.length;
    
    if (type === 'batal') {
        const tunggakanCount = data.filter(d => d.ALASAN === 'Tunggakan').length;
        statTunggakan.textContent = tunggakanCount;
    }
}

function showEmptyState() {
    tableBody.innerHTML = '<tr><td colspan="10" style="text-align: center; padding: 3rem; color: var(--text-secondary);">Silakan klik tombol <strong>"Tampilkan Data"</strong> untuk memuat data dari database.</td></tr>';
    statTotal.textContent = '0';
    statTotalJumlah.textContent = 'Rp 0';
    pageCount.textContent = '0';
    statTunggakan.textContent = '0';
    currentData = []; // Reset stored data
    searchInput.value = '';
}

// Tab Switching
function switchTab(tabId) {
    currentTab = tabId;
    
    // Update Active Class
    navItems.forEach(btn => btn.classList.remove('active'));
    document.querySelector(`[data-tab="${tabId}"]`).classList.add('active');
    
    // Update Title and UI Elements
    if (tabId === 'beli') {
        pageTitle.textContent = 'Rencana Beli YKK';
        thAlasan.style.display = 'none';
        statCardAlasan.style.display = 'none';
    } else {
        pageTitle.textContent = 'Rencana Pembatalan YKK';
        thAlasan.style.display = 'table-cell';
        statCardAlasan.style.display = 'flex';
    }
    
    const periode = getSelectedPeriode();
    
    // Update SQL Code
    sqlCode.textContent = getQueries(periode)[tabId];
    
    // Reset table to empty state when switching tab instead of auto-fetching
    showEmptyState();
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

// Search functionality
searchInput.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase();
    const filtered = currentData.filter(row => {
        const noPdam = (row.NO_PDAM || '').toString().toLowerCase();
        const nama = (row.NAMA || '').toString().toLowerCase();
        return noPdam.includes(query) || nama.includes(query);
    });
    renderTable(filtered, currentTab);
});

// Export functionality
btnExport.addEventListener('click', () => {
    if (currentData.length === 0) {
        alert('Tidak ada data untuk diekspor.');
        return;
    }
    
    // Get currently visible data (filtered)
    const query = searchInput.value.toLowerCase();
    const dataToExport = currentData.filter(row => {
        const noPdam = (row.NO_PDAM || '').toString().toLowerCase();
        const nama = (row.NAMA || '').toString().toLowerCase();
        return noPdam.includes(query) || nama.includes(query);
    });
    
    if (dataToExport.length === 0) return;
    
    const headers = ['NO_PDAM', 'NAMA_PELANGGAN', 'PERIODE', 'LOKASI_BAYAR', 'GOLONGAN', 'RK', 'NON_AIR', 'JUMLAH'];
    if (currentTab === 'batal') headers.push('ALASAN');
    
    const csvRows = [headers.join(',')];
    
    dataToExport.forEach(row => {
        const rk = parseFloat(row.RK) || 0;
        const nonAir = parseFloat(row.NON_AIR) || 0;
        const jumlah = rk + nonAir;
        
        const cols = [
            `"${row.NO_PDAM}"`,
            `"${(row.NAMA || '').replace(/"/g, '""')}"`,
            `"${row.PERIODE}"`,
            `"${row.LOKBAY_ID}"`,
            `"${row.STGOL_ID}"`,
            rk,
            nonAir,
            jumlah
        ];
        
        if (currentTab === 'batal') cols.push(`"${row.ALASAN || ''}"`);
        
        csvRows.push(cols.join(','));
    });
    
    const csvString = csvRows.join('\n');
    const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    
    link.setAttribute('href', url);
    link.setAttribute('download', `data_${currentTab}_${new Date().toISOString().slice(0,10)}.csv`);
    link.style.display = 'none';
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
});

// Init
const urlParams = new URLSearchParams(window.location.search);
const paramTab = urlParams.get('tab');
const paramDate = urlParams.get('date');
const autoLoad = urlParams.get('autoload');

if (paramTab && (paramTab === 'beli' || paramTab === 'batal')) {
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
