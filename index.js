const path = require('path');
const express = require('express');
const { createServer } = require('beatlink-core');
const config = require('./scripts/config.js');
const midiPlugin = require('./server/midiPlugin.js');

const server = createServer({
    roles: ['host', 'public', 'participant'],
    session: {
        numParticipants: config.NUM_TRACKS,
        allocation: 'random',
        hostDisconnect: 'preserve',
        turnTaking: { count: 'time', threshold: 60 }
    },
    routedMessages: {
        enabled: true,
        defaultTarget: 'host',
        allowedTargets: ['host']
    },
    plugins: [midiPlugin],
    logging: { label: 'chaotic-pedalboard' }
});

const { app } = server;

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'html/index-controller.html'));
});

app.get('/controller', (req, res) => {
    const page = req.query.session ? 'html/controller.html' : 'html/index-controller.html';
    res.sendFile(path.join(__dirname, page));
});

// Old name: keep bookmarks and shared links working (query string kept).
app.get('/sequencer', (req, res) => {
    res.redirect(req.originalUrl.replace(/^\/sequencer/, '/controller'));
});

app.get('/track', (req, res) => {
    res.sendFile(path.join(__dirname, 'html/track.html'));
});

app.get('/public', (req, res) => {
    res.sendFile(path.join(__dirname, 'html/public.html'));
});

app.get('/grid', (req, res) => {
    res.sendFile(path.join(__dirname, 'html/grid.html'));
});

app.get('/ambsynth', (req, res) => {
    res.sendFile(path.join(__dirname, 'html/ambsynth.html'));
});

app.get('/testbed', (req, res) => {
    res.sendFile(path.join(__dirname, 'html/testbed.html'));
});

app.get('/latency', (req, res) => {
    res.sendFile(path.join(__dirname, 'html/latency.html'));
});

app.get('/favicon.ico', (req, res) => {
    res.status(204).end();
});

app.use('/scripts', express.static(path.join(__dirname, 'scripts')));
app.use('/css', express.static(path.join(__dirname, 'css')));
app.use('/images', express.static(path.join(__dirname, 'images')));
app.use('/node_modules', express.static(path.join(__dirname, 'node_modules')));

if (require.main === module) {
    server.listen(process.env.PORT || 3000);
}

module.exports = { server };
