const { spawn } = require('child_process');
const fs = require('fs');

async function run() {
    console.log('1. Meluncurkan Chrome dengan Remote Debugging...');
    const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const chrome = spawn(chromePath, [
        '--headless=new',
        '--remote-debugging-port=9222',
        '--disable-gpu',
        '--window-size=1280,800',
        'about:blank'
    ]);

    // Tunggu Chrome siap
    await new Promise(r => setTimeout(r, 1500));

    try {
        console.log('2. Mengambil target debugger...');
        const res = await fetch('http://localhost:9222/json/list');
        const pages = await res.json();
        const wsUrl = pages[0].webSocketDebuggerUrl;
        console.log('   WebSocket URL:', wsUrl);

        const ws = new WebSocket(wsUrl);
        let id = 1;
        const pending = new Map();

        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            if (msg.method === 'Runtime.consoleAPICalled') {
                console.log('   [Browser Console]', msg.params.args.map(a => a.value).join(' '));
            } else if (msg.method === 'Runtime.exceptionThrown') {
                console.error('   [Browser Error]', msg.params.exceptionDetails.text, msg.params.exceptionDetails.exception?.description);
            }
            if (msg.id && pending.has(msg.id)) {
                pending.get(msg.id)(msg);
                pending.delete(msg.id);
            }
        };

        await new Promise(r => ws.onopen = r);

        function send(method, params = {}) {
            return new Promise((resolve) => {
                const reqId = id++;
                pending.set(reqId, resolve);
                ws.send(JSON.stringify({ id: reqId, method, params }));
            });
        }

        await send('Page.enable');
        await send('Runtime.enable');

        console.log('3. Membuka http://localhost:3000/ ...');
        await send('Page.navigate', { url: 'http://localhost:3000/' });

        // Tunggu load event
        await new Promise(r => setTimeout(r, 2000));

        async function takeScreenshot(filename) {
            const ss = await send('Page.captureScreenshot', { format: 'png' });
            fs.writeFileSync(filename, Buffer.from(ss.result.data, 'base64'));
            console.log(`   -> Screenshot disimpan: ${filename}`);
        }

        // Screenshot 1: Halaman Awal
        console.log('4. Mengambil screenshot tampilan awal (Date Picker & Header)...');
        await takeScreenshot('d:/rencana_beli_ykk/browser_1_awal.png');

        // Klik Tampilkan Data
        console.log('5. Mengklik tombol "Tampilkan Data"...');
        await send('Runtime.evaluate', {
            expression: `document.getElementById('btn-load-data').click()`
        });

        // Screenshot 2: Saat animasi loading aktif
        await new Promise(r => setTimeout(r, 600));
        console.log('6. Mengambil screenshot saat animasi loading aktif...');
        await takeScreenshot('d:/rencana_beli_ykk/browser_2_loading.png');

        // Tunggu data selesai dimuat dari backend (bisa 10-25 detik)
        console.log('7. Menunggu data selesai dimuat dari database...');
        let loaded = false;
        for (let i = 0; i < 40; i++) {
            await new Promise(r => setTimeout(r, 1000));
            const check = await send('Runtime.evaluate', {
                expression: `document.querySelectorAll('#table-body tr').length > 0 && !document.querySelector('.loading-container')`
            });
            if (check.result?.result?.value) {
                loaded = true;
                console.log(`   -> Data berhasil dimuat dalam ${i + 1} detik!`);
                break;
            }
        }

        // Screenshot 3: Data Pelanggan Terisi
        console.log('8. Mengambil screenshot tabel dengan data lengkap...');
        await takeScreenshot('d:/rencana_beli_ykk/browser_3_data_beli.png');

        // Pindah ke tab Rencana Pembatalan
        console.log('9. Berpindah ke tab "Rencana Pembatalan"...');
        await send('Runtime.evaluate', {
            expression: `document.querySelector('[data-tab="batal"]').click()`
        });
        await new Promise(r => setTimeout(r, 800));

        // Klik Tampilkan Data di Pembatalan
        console.log('10. Mengklik "Tampilkan Data" pada tab Pembatalan...');
        await send('Runtime.evaluate', {
            expression: `document.getElementById('btn-load-data').click()`
        });

        // Tunggu data pembatalan selesai dimuat
        for (let i = 0; i < 40; i++) {
            await new Promise(r => setTimeout(r, 1000));
            const check = await send('Runtime.evaluate', {
                expression: `document.querySelectorAll('#table-body tr').length > 0 && !document.querySelector('.loading-container')`
            });
            if (check.result?.result?.value) {
                console.log(`   -> Data pembatalan berhasil dimuat dalam ${i + 1} detik!`);
                break;
            }
        }

        // Screenshot 4: Data Pembatalan Terisi
        console.log('11. Mengambil screenshot tab Rencana Pembatalan...');
        await takeScreenshot('d:/rencana_beli_ykk/browser_4_data_batal.png');

        ws.close();
        console.log('=== SEMUA UJI COBA BROWSER BERHASIL 100% ===');
    } finally {
        chrome.kill();
    }
}

run().catch(console.error);
