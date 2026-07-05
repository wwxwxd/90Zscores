const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// 1. إعداد تطبيق Express حتى يعمل السيرفر على Render.com (يتطلب ربط بورت)
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('90Zscores Backend Server is running 24/7! 🚀');
});

const fs = require('fs');

// 2. إعداد الاتصال بقاعدة بيانات Firebase
let serviceAccountPath = './serviceAccountKey.json';
if (process.env.RENDER && fs.existsSync('/etc/secrets/serviceAccountKey.json')) {
    serviceAccountPath = '/etc/secrets/serviceAccountKey.json';
}

let db;
try {
    const serviceAccount = require(serviceAccountPath);
    initializeApp({
        credential: cert(serviceAccount)
    });
    db = getFirestore();
    console.log("Firebase Connected Successfully! ✅ (using " + serviceAccountPath + ")");
} catch (error) {
    console.error(`⚠️ FATAL ERROR: Could not connect to Firebase using path ${serviceAccountPath}`);
    console.error(error);
    process.exit(1); // Exit early if Firebase cannot connect
}

// 3. إعدادات API-Football
const API_KEY = process.env.zscores || "33f4987f1f0263669d631c6e0264076c";
const API_URL = "https://v3.football.api-sports.io/";
const headers = { "x-apisports-key": API_KEY };

const delay = (ms) => new Promise(res => setTimeout(res, ms));

// ==========================================
// ⚽ محرك المباريات (The Matches Engine) ⚽
// ==========================================

async function fetchAndSyncMatches() {
    try {
        // جلب المباريات الحية
        const response = await axios.get(`${API_URL}fixtures?live=all`, { headers });
        const matches = response.data.response || [];
        
        // جلب مباريات اليوم
        const today = new Date().toISOString().split('T')[0];
        const todayResponse = await axios.get(`${API_URL}fixtures?date=${today}`, { headers });
        const allTodayMatches = todayResponse.data.response || [];

        // تنظيف وتنسيق بيانات مباريات اليوم (The Parser)
        const parsedMatches = allTodayMatches.map((m) => {
            return {
                id: m.fixture.id,
                date: m.fixture.date,
                timestamp: m.fixture.timestamp,
                status: m.fixture.status.short === 'NS' ? 'upcoming' : 
                       (m.fixture.status.short === 'FT' || m.fixture.status.short === 'PEN' ? 'finished' : 'live'),
                elapsed: m.fixture.status.elapsed,
                league: {
                    id: m.league.id,
                    name: m.league.name,
                    logo: m.league.logo
                },
                homeTeam: {
                    id: m.teams.home.id,
                    name: m.teams.home.name,
                    logo: m.teams.home.logo
                },
                awayTeam: {
                    id: m.teams.away.id,
                    name: m.teams.away.name,
                    logo: m.teams.away.logo
                },
                score: m.fixture.status.short === 'NS' ? 'VS' : `${m.goals.home ?? 0} - ${m.goals.away ?? 0}`,
                time: new Date(m.fixture.date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
                channel: "beIN Sports", // افتراضي
            };
        });

        // دمج المباريات الحية (الأهداف الدقيقة، الوقت المنقضي)
        matches.forEach((liveMatch) => {
            const index = parsedMatches.findIndex((p) => p.id === liveMatch.fixture.id);
            if (index !== -1) {
                parsedMatches[index].status = 'live';
                parsedMatches[index].elapsed = liveMatch.fixture.status.elapsed;
                parsedMatches[index].score = `${liveMatch.goals.home ?? 0} - ${liveMatch.goals.away ?? 0}`;
                
                // حفظ أحداث المباراة (أهداف، كروت) لتظهر في الواجهة
                if (liveMatch.events) {
                   db.collection("config").doc(`events_${liveMatch.fixture.id}`).set({ events: liveMatch.events }).catch(console.error);
                }
            }
        });

        // إرسال البيانات المجمعة لقاعدة البيانات لتلتقطها تطبيقات React و Android
        await db.collection("config").doc("matches_cache").set({
            matchesList: parsedMatches,
            lastFetched: Date.now()
        }, { merge: true });

        console.log(`[${new Date().toLocaleTimeString()}] Synced ${parsedMatches.length} today matches, ${matches.length} are live.`);
    } catch (err) {
        console.error("fetchAndSyncMatches Error:", err.message);
    }
}

// تشغيل محرك المباريات كل دقيقة، وتكراره داخلياً كل 20 ثانية لتحديث أسرع!
cron.schedule('* * * * *', async () => {
    try {
        for (let i = 0; i < 3; i++) {
            await fetchAndSyncMatches();
            if (i < 2) await delay(20000); // انتظر 20 ثانية بين كل طلب
        }
    } catch (e) {
        console.error("Match Engine Error:", e.message);
    }
});


// ==========================================
// 🔄 محرك الانتقالات (The Transfers Engine) 🔄
// ==========================================

async function fetchAndSyncTransfers() {
    try {
        // أرقام أندية كبرى للمتابعة
        const topTeams = [541, 529, 33, 40, 42, 50, 47, 49, 157, 109]; 
        let allTransfers = [];

        console.log("Starting transfers sync...");

        for (const teamId of topTeams) {
            const res = await axios.get(`${API_URL}transfers?team=${teamId}`, { headers });
            const teamTransfers = res.data.response || [];
            
            teamTransfers.forEach((t) => {
                const transfersList = t.transfers || [];
                transfersList.forEach((tr) => {
                    allTransfers.push({
                        playerName: t.player.name,
                        playerId: t.player.id,
                        date: tr.date,
                        type: tr.type,
                        outTeamName: tr.teams.out.name,
                        outTeamLogo: tr.teams.out.logo,
                        inTeamName: tr.teams.in.name,
                        inTeamLogo: tr.teams.in.logo,
                        playerPhoto: `https://media.api-sports.io/football/players/${t.player.id}.png`
                    });
                });
            });
            await delay(1000); // لحماية الـ API من الحظر
        }

        // تنظيف البيانات من التكرار وأخذ أحدث 50 صفقة فقط
        const uniqueTransfers = Array.from(new Set(allTransfers.map(a => a.playerName + a.date)))
            .map(id => allTransfers.find(a => a.playerName + a.date === id))
            .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
            .slice(0, 50);

        await db.collection("config").doc("transfers").set({
            list: uniqueTransfers,
            lastUpdated: Date.now()
        });

        console.log(`[${new Date().toLocaleTimeString()}] Synced ${uniqueTransfers.length} latest transfers.`);
    } catch (error) {
        console.error("fetchAndSyncTransfers Error:", error.message);
    }
}

// تشغيل محرك الانتقالات كل 6 ساعات
cron.schedule('0 */6 * * *', () => {
    fetchAndSyncTransfers();
});


// ==========================================
// 🚀 تشغيل الخادم
// ==========================================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
    // جلب أولي للبيانات عند بدء التشغيل
    fetchAndSyncMatches();
    fetchAndSyncTransfers();
});
