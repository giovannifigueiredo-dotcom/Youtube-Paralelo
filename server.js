const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== YOUTUBE INNERTUBE API =====
// This is YouTube's own internal API — same one used by the website/app
const INNERTUBE_BASE = 'https://www.youtube.com/youtubei/v1';
const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'; // Public InnerTube key

const INNERTUBE_CONTEXT = {
  client: {
    clientName: 'WEB',
    clientVersion: '2.20240101.00.00',
    hl: 'pt',
    gl: 'BR',
    platform: 'DESKTOP',
  },
};

const HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'pt-BR,pt;q=0.9',
  'Origin': 'https://www.youtube.com',
  'Referer': 'https://www.youtube.com/',
};

// ===== MIDDLEWARE =====
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  next();
});

// ===== HELPER: InnerTube POST =====
async function innertubePost(endpoint, body, timeout = 15000) {
  const url = `${INNERTUBE_BASE}/${endpoint}?key=${INNERTUBE_KEY}&prettyPrint=false`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ context: INNERTUBE_CONTEXT, ...body }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ===== PARSER: Extract videos from InnerTube response =====
function extractVideos(data) {
  const videos = [];

  function walk(obj) {
    if (!obj || typeof obj !== 'object') return;

    if (obj.videoRenderer) {
      const v = obj.videoRenderer;
      videos.push(parseVideoRenderer(v));
      return;
    }

    if (obj.richItemRenderer?.content?.videoRenderer) {
      const v = obj.richItemRenderer.content.videoRenderer;
      videos.push(parseVideoRenderer(v));
      return;
    }

    if (obj.compactVideoRenderer) {
      const v = obj.compactVideoRenderer;
      videos.push(parseCompactRenderer(v));
      return;
    }

    if (Array.isArray(obj)) {
      obj.forEach(walk);
    } else {
      Object.values(obj).forEach(walk);
    }
  }

  walk(data);
  return videos;
}

function parseVideoRenderer(v) {
  const id = v.videoId || '';
  const title = v.title?.runs?.map(r => r.text).join('') || v.title?.simpleText || '';
  const channel = v.ownerText?.runs?.map(r => r.text).join('') ||
                  v.longBylineText?.runs?.map(r => r.text).join('') ||
                  v.shortBylineText?.runs?.map(r => r.text).join('') || '';
  const views = v.viewCountText?.simpleText || v.viewCountText?.runs?.map(r => r.text).join('') || '';
  const viewCount = parseInt((views.match(/[\d.,]+/) || ['0'])[0].replace(/[.,]/g, '')) || 0;
  const published = v.publishedTimeText?.simpleText || v.publishedTimeText?.runs?.map(r => r.text).join('') || '';
  const duration = v.lengthText?.simpleText || '';
  const durationSec = parseDuration(duration);
  const thumb = v.thumbnail?.thumbnails?.slice(-1)[0]?.url || `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
  const desc = v.detailedMetadataSnippets?.[0]?.snippetText?.runs?.map(r => r.text).join('') ||
               v.descriptionSnippet?.runs?.map(r => r.text).join('') || '';

  return {
    type: 'video',
    videoId: id,
    title,
    author: channel,
    viewCount,
    viewCountText: views,
    publishedText: published,
    lengthSeconds: durationSec,
    durationText: duration,
    videoThumbnails: [{ quality: 'medium', url: thumb }],
    description: desc,
  };
}

function parseCompactRenderer(v) {
  const id = v.videoId || '';
  const title = v.title?.simpleText || v.title?.runs?.map(r => r.text).join('') || '';
  const channel = v.longBylineText?.runs?.map(r => r.text).join('') ||
                  v.shortBylineText?.runs?.map(r => r.text).join('') || '';
  const views = v.viewCountText?.simpleText || '';
  const viewCount = parseInt((views.match(/[\d.,]+/) || ['0'])[0].replace(/[.,]/g, '')) || 0;
  const published = v.publishedTimeText?.simpleText || '';
  const duration = v.lengthText?.simpleText || '';
  const thumb = v.thumbnail?.thumbnails?.slice(-1)[0]?.url || `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;

  return {
    type: 'video',
    videoId: id,
    title,
    author: channel,
    viewCount,
    viewCountText: views,
    publishedText: published,
    lengthSeconds: parseDuration(duration),
    durationText: duration,
    videoThumbnails: [{ quality: 'medium', url: thumb }],
    description: '',
  };
}

function parseDuration(str) {
  if (!str) return 0;
  const parts = str.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

// ================================================================
//  API ROUTES
// ================================================================

// ===== SEARCH =====
app.get('/api/search', async (req, res) => {
  const { q, continuation } = req.query;
  if (!q) return res.status(400).json({ error: 'Parâmetro "q" é obrigatório' });

  console.log(`\n🔍 Pesquisando: "${q}"`);

  try {
    const body = { query: q };
    if (continuation) body.continuation = continuation;

    const data = await innertubePost('search', body);
    const videos = extractVideos(data);

    console.log(`   ✓ Encontrados: ${videos.length} vídeos`);
    return res.json({ source: 'innertube', videos });
  } catch (err) {
    console.log(`   ✗ InnerTube error: ${err.message}`);
    return res.status(503).json({ error: `Erro ao pesquisar: ${err.message}` });
  }
});

// ===== TRENDING =====
app.get('/api/trending', async (req, res) => {
  console.log('\n🔥 Tendências');

  try {
    // Browse trending page
    const data = await innertubePost('browse', {
      browseId: 'FEtrending',
    });

    const videos = extractVideos(data);

    if (videos.length > 0) {
      console.log(`   ✓ Encontrados: ${videos.length} vídeos`);
      return res.json({ source: 'innertube', videos });
    }

    // Fallback: search popular
    console.log('   ⟳ Fallback: searching popular...');
    const fallback = await innertubePost('search', {
      query: 'popular videos brasil ' + new Date().getFullYear(),
    });
    const fallbackVideos = extractVideos(fallback);
    return res.json({ source: 'innertube', videos: fallbackVideos });
  } catch (err) {
    console.log(`   ✗ Error: ${err.message}`);
    res.status(503).json({ error: `Erro ao carregar tendências: ${err.message}` });
  }
});

// ===== VIDEO DETAILS + RELATED =====
app.get('/api/streams/:id', async (req, res) => {
  const { id } = req.params;
  console.log(`\n🎥 Streams + Info: ${id}`);

  try {
    // Fetch video info (player)
    const playerData = await innertubePost('player', {
      videoId: id,
      playbackContext: {
        contentPlaybackContext: { signatureTimestamp: 20000 },
      },
    });

    // Fetch related videos (next)
    const nextData = await innertubePost('next', {
      videoId: id,
    });

    const details = playerData.videoDetails || {};
    const microformat = playerData.microformat?.playerMicroformatRenderer || {};

    // Extract related
    const related = extractVideos(nextData);

    // Extract description from next endpoint (more complete)
    let description = details.shortDescription || '';
    try {
      const descRuns = nextData?.contents?.twoColumnWatchNextResults?.results?.results?.contents
        ?.find(c => c.videoSecondaryInfoRenderer)
        ?.videoSecondaryInfoRenderer?.attributedDescription?.content;
      if (descRuns) description = descRuns;
    } catch(e) {}

    // Extract channel name
    let uploader = details.author || '';
    try {
      const ownerRuns = nextData?.contents?.twoColumnWatchNextResults?.results?.results?.contents
        ?.find(c => c.videoSecondaryInfoRenderer)
        ?.videoSecondaryInfoRenderer?.owner?.videoOwnerRenderer?.title?.runs;
      if (ownerRuns) uploader = ownerRuns.map(r => r.text).join('');
    } catch(e) {}

    const result = {
      source: 'innertube',
      title: details.title || '',
      uploader: uploader || details.author || '',
      duration: parseInt(details.lengthSeconds) || 0,
      views: parseInt(details.viewCount) || 0,
      uploadDate: microformat.publishDate || microformat.uploadDate || '',
      description,
      thumbnail: details.thumbnail?.thumbnails?.slice(-1)[0]?.url || `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`,
      relatedStreams: related.slice(0, 15),
    };

    console.log(`   ✓ "${result.title}" — ${related.length} relacionados`);
    return res.json(result);
  } catch (err) {
    console.log(`   ✗ Error: ${err.message}`);
    res.status(503).json({ error: `Erro ao obter streams: ${err.message}` });
  }
});

// ===== VIDEO DETAILS (simple) =====
app.get('/api/video/:id', async (req, res) => {
  const { id } = req.params;
  console.log(`\n📺 Detalhes: ${id}`);

  try {
    const data = await innertubePost('player', { videoId: id });
    const d = data.videoDetails || {};

    return res.json({
      source: 'innertube',
      video: {
        videoId: d.videoId || id,
        title: d.title || '',
        author: d.author || '',
        viewCount: parseInt(d.viewCount) || 0,
        lengthSeconds: parseInt(d.lengthSeconds) || 0,
        description: d.shortDescription || '',
        videoThumbnails: d.thumbnail?.thumbnails || [],
      },
    });
  } catch (err) {
    res.status(503).json({ error: `Erro: ${err.message}` });
  }
});

// ===== COMMENTS =====
app.get('/api/comments/:id', async (req, res) => {
  const { id } = req.params;
  console.log(`\n💬 Comentários: ${id}`);

  try {
    const nextData = await innertubePost('next', { videoId: id });

    // Find the comments continuation token
    let commentsToken = null;
    try {
      const items = nextData?.contents?.twoColumnWatchNextResults?.results?.results?.contents || [];
      for (const item of items) {
        const sectionRenderer = item.itemSectionRenderer;
        if (sectionRenderer?.contents?.[0]?.continuationItemRenderer) {
          commentsToken = sectionRenderer.contents[0].continuationItemRenderer
            .continuationEndpoint?.continuationCommand?.token;
          break;
        }
      }
    } catch(e) {}

    if (!commentsToken) {
      return res.json({ comments: [], message: 'Sem token de comentários disponível' });
    }

    // Fetch comments
    const commentsData = await innertubePost('next', {
      continuation: commentsToken,
    });

    const comments = [];
    function extractComments(obj) {
      if (!obj || typeof obj !== 'object') return;
      if (obj.commentThreadRenderer) {
        const c = obj.commentThreadRenderer.comment?.commentRenderer;
        if (c) {
          comments.push({
            author: c.authorText?.simpleText || '',
            content: c.contentText?.runs?.map(r => r.text).join('') || '',
            likeCount: c.voteCount?.simpleText || '0',
            publishedTime: c.publishedTimeText?.runs?.map(r => r.text).join('') || '',
            authorThumb: c.authorThumbnail?.thumbnails?.[0]?.url || '',
          });
        }
        return;
      }
      if (Array.isArray(obj)) obj.forEach(extractComments);
      else Object.values(obj).forEach(extractComments);
    }

    extractComments(commentsData);

    console.log(`   ✓ ${comments.length} comentários`);
    return res.json({ comments });
  } catch (err) {
    console.log(`   ✗ Error: ${err.message}`);
    res.status(503).json({ error: `Erro: ${err.message}` });
  }
});

// ===== SUGGESTIONS =====
app.get('/api/suggestions', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);

  try {
    const url = `https://suggestqueries-clients6.youtube.com/complete/search?client=youtube&q=${encodeURIComponent(q)}&ds=yt&hl=pt`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': HEADERS['User-Agent'] },
    });
    clearTimeout(timer);

    const text = await resp.text();
    if (text.trim().startsWith('<')) return res.json([]);

    const match = text.match(/\[.*\]/s);
    if (match) {
      const data = JSON.parse(match[0]);
      const suggestions = (data[1] || []).map(s => s[0]);
      return res.json(suggestions);
    }
    res.json([]);
  } catch (err) {
    res.json([]);
  }
});

// ===== PROXY: Thumbnail =====
app.get('/api/proxy/thumb/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const quality = req.query.q || 'mqdefault';

  try {
    const url = `https://i.ytimg.com/vi/${videoId}/${quality}.jpg`;
    const response = await fetch(url);
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    response.body.pipe(res);
  } catch (err) {
    res.status(500).send('Thumbnail proxy failed');
  }
});

// ===== PROXY: Stream =====
app.get('/api/proxy/stream', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL required' });

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': HEADERS['User-Agent'],
        'Range': req.headers.range || '',
      },
    });

    res.status(response.status);
    ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach(h => {
      if (response.headers.get(h)) res.set(h, response.headers.get(h));
    });

    response.body.pipe(res);
  } catch (err) {
    res.status(500).json({ error: 'Stream proxy failed' });
  }
});

// ===== HEALTH =====
app.get('/api/health', async (req, res) => {
  try {
    const start = Date.now();
    await innertubePost('search', { query: 'test' });
    res.json({ status: 'ok', latency: Date.now() - start, source: 'innertube' });
  } catch (err) {
    res.json({ status: 'error', error: err.message });
  }
});

// ===== SERVE FRONTEND =====
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Endpoint not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===== START =====
app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║          🎬  YouTube Paralelo - Servidor             ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  🌐 Acesse: http://localhost:${PORT}                    ║`);
  console.log('║  📺 Pesquise e assista vídeos livremente!             ║');
  console.log('║  ⚡ Usando YouTube InnerTube API (direto do YT)      ║');
  console.log('║  🛑 Ctrl+C para parar o servidor                     ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');
});
