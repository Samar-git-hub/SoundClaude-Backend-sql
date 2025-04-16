import dotenv from 'dotenv';
import express from 'express';
import multer from 'multer';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import axios from 'axios';
import FormData from 'form-data';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { connectToDatabase, query, initializeDatabase } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();

const app = express();

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const embedModel = genAI.getGenerativeModel({ model: "embedding-001" });

app.use(express.json());
app.use(cors({
  origin: ['http://localhost:5173', 'https://sound-wave-teal.vercel.app'],
  credentials: true
}));

const uploadDir = join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(new Error('Only audio files are allowed'));
    }
  }
});

app.use('/uploads', express.static(uploadDir));
// Removed auth routes import and usage

async function uploadToCatbox(filePath, filename) {
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('fileToUpload', fs.createReadStream(filePath), filename);

  try {
    const response = await axios.post('https://catbox.moe/user/api.php', form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });
    return response.data;
  } catch (error) {
    console.error('Catbox upload error:', error);
    throw error;
  }
}

async function processWithSonoteller(songUrl) {
  const encodedParams = new URLSearchParams();
  encodedParams.set('file', songUrl);

  const apiUrl = 'https://sonoteller-ai1.p.rapidapi.com/lyrics_ddex';
  const apiOptions = {
    method: 'POST',
    headers: {
      'x-rapidapi-key': process.env.RAPID_API_KEY,
      'x-rapidapi-host': 'sonoteller-ai1.p.rapidapi.com',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: encodedParams
  };

  const response = await fetch(apiUrl, apiOptions);
  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`API request failed: ${response.status} - ${responseText}`);
  }

  try {
    return JSON.parse(responseText);
  } catch (e) {
    throw new Error(`Invalid JSON response: ${responseText}`);
  }
}

async function storeSongData(songData, filePath, filename, songUrl, userId = null) {
  const combinedText = [
    songData.summary || '',
    ...Object.values(songData.keywords || {}),
    ...Object.values(songData['ddex moods'] || {}),
    ...Object.values(songData['ddex themes'] || {})
  ].join(' ');

  const embeddingResponse = await embedModel.embedContent(combinedText);
  const embedding = JSON.stringify(embeddingResponse.embedding.values);

  // Convert explicit string value to boolean for the database
  let isExplicit = false;
  if (typeof songData.explicit === 'boolean') {
    isExplicit = songData.explicit;
  } else if (songData.explicit === 'Yes' || songData.explicit === 'yes' || 
             songData.explicit === 'true' || songData.explicit === 'TRUE' || 
             songData.explicit === '1') {
    isExplicit = true;
  }

  // Insert into songs table
  const songsSql = `
    INSERT INTO songs (
      user_id, songUrl, filePath, filename, language, language_iso, summary, 
      explicit, keywords, ddex_moods, ddex_themes, flags, embedding
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  
  const songValues = [
    userId,
    songUrl,
    filePath,
    filename,
    songData.language || 'unknown',
    songData['language-iso'] || 'unknown',
    songData.summary || '',
    isExplicit, // Use the converted boolean value here
    JSON.stringify(Object.values(songData.keywords || {})),
    JSON.stringify(Object.values(songData['ddex moods'] || {})),
    JSON.stringify(Object.values(songData['ddex themes'] || {})),
    JSON.stringify(songData.flags || {}),
    embedding
  ];

  // Insert song record
  const songResult = await query(songsSql, songValues);
  const songId = songResult.insertId;

  // Rest of your function remains the same...
  // Get audio file stats for metadata
  const stats = fs.statSync(filePath);
  const fileSize = stats.size;
  
  // Determine format from filename
  const format = filename.split('.').pop().toLowerCase();

  // Insert audio metadata
  const metadataSql = `
    INSERT INTO song_audio_metadata (
      song_id, format, file_size, created_at
    ) VALUES (?, ?, ?, NOW())
  `;
  
  const metadataValues = [
    songId,
    format,
    fileSize
  ];
  
  const metadataResult = await query(metadataSql, metadataValues);
  
  return songId;
}

// Modify the upload endpoint in your index.js file to update the upload_count
app.post('/upload', upload.single('songFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    // Get user ID from request (query param, body, or auth token)
    // In a real app, this would come from authentication middleware
    const userId = req.body.user_id || req.query.user_id || null;
    
    // Validate user ID if provided
    if (userId) {
      try {
        const userSql = 'SELECT id FROM users WHERE id = ?';
        const users = await query(userSql, [userId]);
        
        if (!users || users.length === 0) {
          return res.status(400).json({ error: 'Invalid user ID' });
        }
        
        // Increment the upload_count for this user
        const updateUploadCountSql = 'UPDATE users SET upload_count = upload_count + 1 WHERE id = ?';
        await query(updateUploadCountSql, [userId]);
      } catch (err) {
        console.error('Error validating user or updating upload count:', err);
        // Continue with upload even if user validation fails
      }
    }

    const songUrl = await uploadToCatbox(req.file.path, req.file.originalname);
    const sonotellerResult = await processWithSonoteller(songUrl);
    const songId = await storeSongData(sonotellerResult, req.file.path, req.file.filename, songUrl, userId);

    // Get the complete song data with format information
    const songDetailsSql = `
      SELECT s.*, m.format, m.file_size
      FROM songs s
      LEFT JOIN song_audio_metadata m ON s.id = m.song_id
      WHERE s.id = ?
    `;
    
    const songDetails = await query(songDetailsSql, [songId]);
    const song = songDetails[0];
    
    return res.status(200).json({
      success: true,
      message: 'Song processed and stored successfully',
      song: {
        ...song,
        playUrl: `/audio/${songId}`,
        downloadUrl: `/audio/${songId}?download=true`,
        songId: songId.toString(),
        userId: userId
      },
      analysis: {
        language: sonotellerResult.language || 'unknown',
        summary: sonotellerResult.summary || '',
        moods: Object.values(sonotellerResult['ddex moods'] || {}),
        themes: Object.values(sonotellerResult['ddex themes'] || {}),
        keywords: Object.values(sonotellerResult.keywords || {})
      }
    });
  } catch (error) {
    console.error('Upload error:', error);
    return res.status(500).json({ error: 'File upload failed', details: error.message });
  }
});


// Endpoint to get all songs for a specific user
app.get('/user/:userId/songs', async (req, res) => {
  try {
    const userId = req.params.userId;
    
    // Validate user exists
    const userSql = 'SELECT id FROM users WHERE id = ?';
    const users = await query(userSql, [userId]);
    
    if (!users || users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Get all songs for the user
    const songsSql = `
      SELECT s.*, m.format, m.file_size 
      FROM songs s
      LEFT JOIN song_audio_metadata m ON s.id = m.song_id
      WHERE s.user_id = ?
      ORDER BY s.createdAt DESC
    `;
    
    const songs = await query(songsSql, [userId]);
    
    res.json({
      userId: userId,
      total: songs.length,
      songs: songs
    });
  } catch (error) {
    console.error('Error retrieving user songs:', error);
    res.status(500).json({ error: 'Failed to retrieve user songs', details: error.message });
  }
});

app.get('/search', async (req, res) => {
  try {
    // Get search parameter
    const searchTerm = req.query.q || '';
    
    let songs = [];
    let similaritiesMap = {};
    
    // Log all available songs for debugging
    const allSongsSql = `SELECT COUNT(*) as count FROM songs`;
    const countResult = await query(allSongsSql);
    console.log(`Total songs in database: ${countResult[0].count}`);
    
    if (searchTerm) {
      console.log('Search term:', searchTerm);
      
      // Generate embedding for search term
      const embeddingResponse = await embedModel.embedContent(searchTerm);
      const searchEmbedding = embeddingResponse.embedding.values;
      
      // Get all songs with their embeddings for semantic search
      const embeddingSql = `SELECT id, embedding, filename, summary, keywords, ddex_moods, ddex_themes FROM songs`;
      const songEmbeddings = await query(embeddingSql);
      
      // Calculate similarity scores for all songs
      const similarSongs = [];
      for (const songEmb of songEmbeddings) {
        try {
          if (songEmb.embedding) {
            const embedding = JSON.parse(songEmb.embedding);
            const similarity = cosineSimilarity(searchEmbedding, embedding);
            similarSongs.push({
              id: songEmb.id,
              similarity: similarity,
              filename: songEmb.filename,
              summary: songEmb.summary,
              keywords: songEmb.keywords,
              ddex_moods: songEmb.ddex_moods,
              ddex_themes: songEmb.ddex_themes
            });
            // Store similarities for reference
            similaritiesMap[songEmb.id] = similarity;
          }
        } catch (parseError) {
          console.log(`Error parsing embedding for song ${songEmb.id}: ${parseError.message}`);
        }
      }
      
      // Sort by similarity and get results with similarity > 0.5
      similarSongs.sort((a, b) => b.similarity - a.similarity);
      const results = similarSongs.filter(s => s.similarity > 0.5);
      
      if (results.length > 0) {
        // Format the results in the desired structure
        const formattedResults = results.map(song => {
          return {
            songId: song.id.toString(),
            similarity: song.similarity,
            songData: {
              filename: song.filename,
              summary: song.summary,
              keywords: JSON.parse(song.keywords || '[]'),
              ddex_moods: JSON.parse(song.ddex_moods || '[]'),
              ddex_themes: JSON.parse(song.ddex_themes || '[]'),
              audioFileId: `${song.id.toString()}` // Using song ID as audio file ID
            }
          };
        });
        
        return res.json({
          success: true,
          results: formattedResults
        });
      }
      
      // If no semantic search results, try direct text search
      if (results.length === 0) {
        const sql = `
          SELECT s.id, s.filename, s.summary, s.keywords, s.ddex_moods, s.ddex_themes
          FROM songs s
          WHERE s.summary LIKE ? 
          OR s.keywords LIKE ? 
          OR s.ddex_moods LIKE ? 
          OR s.ddex_themes LIKE ?
          LIMIT 20
        `;
        
        const plainPattern = `%${searchTerm}%`;
        const jsonPattern = `%"${searchTerm}"%`;
        
        const queryParams = [plainPattern, jsonPattern, jsonPattern, jsonPattern];
        const textSearchResults = await query(sql, queryParams);
        
        if (textSearchResults.length > 0) {
          // Format the results in the desired structure
          const formattedResults = textSearchResults.map(song => {
            return {
              songId: song.id.toString(),
              similarity: similaritiesMap[song.id] || 0.6, // Default similarity for text search
              songData: {
                filename: song.filename,
                summary: song.summary,
                keywords: JSON.parse(song.keywords || '[]'),
                ddex_moods: JSON.parse(song.ddex_moods || '[]'),
                ddex_themes: JSON.parse(song.ddex_themes || '[]'),
                audioFileId: `${song.id.toString()}`
              }
            };
          });
          
          return res.json({
            success: true,
            results: formattedResults
          });
        }
      }
    }
    
    // If no results or no search term, return recent songs
    const recentSql = `
      SELECT s.id, s.filename, s.summary, s.keywords, s.ddex_moods, s.ddex_themes
      FROM songs s
      ORDER BY s.createdAt DESC
      LIMIT 20
    `;
    
    const recentSongs = await query(recentSql);
    
    // Format recent songs in the desired structure
    const formattedRecent = recentSongs.map(song => {
      return {
        songId: song.id.toString(),
        similarity: 0.5, // Default similarity for recent songs
        songData: {
          filename: song.filename,
          summary: song.summary,
          keywords: JSON.parse(song.keywords || '[]'),
          ddex_moods: JSON.parse(song.ddex_moods || '[]'),
          ddex_themes: JSON.parse(song.ddex_themes || '[]'),
          audioFileId: `${song.id.toString()}`
        }
      };
    });
    
    return res.json({
      success: true,
      results: formattedRecent
    });
    
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Search failed', 
      details: error.message 
    });
  }
});

app.get('/songs', async (req, res) => {
  try {
    const sql = `
      SELECT s.id, s.filename, s.summary, 
             SUBSTRING(s.keywords, 1, 100) as keywords_preview,
             SUBSTRING(s.ddex_moods, 1, 100) as moods_preview,
             s.createdAt
      FROM songs s
      ORDER BY s.createdAt DESC
      LIMIT 20
    `;
    
    const songs = await query(sql);
    console.log(`Listing ${songs.length} songs`);
    
    res.json(songs);
  } catch (error) {
    console.error('List songs error:', error);
    res.status(500).json({ error: 'Failed to list songs' });
  }
});

app.get('/song/:id/debug', async (req, res) => {
  try {
    const songId = req.params.id;
    const songData = await query('SELECT * FROM songs WHERE id = ?', [songId]);
    
    if (!songData || songData.length === 0) {
      return res.status(404).json({ error: 'Song not found' });
    }
    
    res.json({
      song: songData[0],
      metadata: {
        keywords: songData[0].keywords ? JSON.parse(songData[0].keywords) : [],
        moods: songData[0].ddex_moods ? JSON.parse(songData[0].ddex_moods) : [],
        themes: songData[0].ddex_themes ? JSON.parse(songData[0].ddex_themes) : []
      }
    });
  } catch (error) {
    console.error('Song debug error:', error);
    res.status(500).json({ error: 'Failed to retrieve song debug data' });
  }
});


app.get('/audio/:id', async (req, res) => {
  try {
    const id = req.params.id;
    
    // Join songs and song_audio_metadata tables to get audio info
    const sql = `
      SELECT s.*, m.format, m.bit_rate, m.sample_rate, m.duration, m.file_size
      FROM songs s
      LEFT JOIN song_audio_metadata m ON s.id = m.song_id
      WHERE s.id = ?
    `;
    
    const songs = await query(sql, [id]);
    
    if (!songs || songs.length === 0) {
      return res.status(404).json({ error: 'Audio file not found' });
    }

    const song = songs[0];
    const filePath = song.filePath;
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Audio file not found on server' });
    }

    // Add Content-Type header based on format
    if (song.format) {
      const mimeTypes = {
        'mp3': 'audio/mpeg',
        'wav': 'audio/wav',
        'ogg': 'audio/ogg',
        'flac': 'audio/flac',
        'm4a': 'audio/mp4'
      };
      
      const contentType = mimeTypes[song.format.toLowerCase()] || 'audio/mpeg';
      res.set('Content-Type', contentType);
    }
    
    // Set appropriate headers
    if (req.query.download === 'true') {
      res.set('Content-Disposition', `attachment; filename="${song.filename}"`);
    } else {
      res.set('Content-Disposition', `inline; filename="${song.filename}"`);
    }
    
    // Stream the file
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    console.error('Error streaming audio:', error);
    res.status(500).json({ error: 'Failed to stream audio' });
  }
});

function cosineSimilarity(vecA, vecB) {
  const dot = vecA.reduce((sum, val, i) => sum + val * vecB[i], 0);
  const magA = Math.sqrt(vecA.reduce((sum, val) => sum + val * val, 0));
  const magB = Math.sqrt(vecB.reduce((sum, val) => sum + val * val, 0));
  return dot / (magA * magB);
}

// Optional endpoint to store binary audio data in the database
app.post('/store-audio-binary/:songId', async (req, res) => {
  try {
    const songId = req.params.songId;
    
    // Get song information
    const songSql = `SELECT * FROM songs WHERE id = ?`;
    const songs = await query(songSql, [songId]);
    
    if (!songs || songs.length === 0) {
      return res.status(404).json({ error: 'Song not found' });
    }
    
    const song = songs[0];
    const filePath = song.filePath;
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Audio file not found on server' });
    }
    
    // Get metadata ID
    const metadataSql = `SELECT id FROM song_audio_metadata WHERE song_id = ?`;
    const metadataResults = await query(metadataSql, [songId]);
    
    if (!metadataResults || metadataResults.length === 0) {
      return res.status(404).json({ error: 'Audio metadata not found' });
    }
    
    const metadataId = metadataResults[0].id;
    
    // Read file as binary data
    const audioData = fs.readFileSync(filePath);
    
    // Store binary data in database
    const binarySql = `
      INSERT INTO song_audio_files (metadata_id, audio_data, created_at)
      VALUES (?, ?, NOW())
    `;
    
    await query(binarySql, [metadataId, audioData]);
    
    res.status(200).json({ 
      success: true,
      message: 'Audio binary data stored successfully',
      songId: songId
    });
  } catch (error) {
    console.error('Error storing binary audio:', error);
    res.status(500).json({ error: 'Failed to store binary audio data', details: error.message });
  }
});

// Endpoint to retrieve binary audio data from database
app.get('/audio-binary/:id', async (req, res) => {
  try {
    const id = req.params.id;
    
    // Join all tables to get complete audio information
    const sql = `
      SELECT s.*, m.format, m.bit_rate, m.sample_rate, m.duration, m.file_size, af.audio_data
      FROM songs s
      JOIN song_audio_metadata m ON s.id = m.song_id
      JOIN song_audio_files af ON m.id = af.metadata_id
      WHERE s.id = ?
    `;
    
    const songs = await query(sql, [id]);
    
    if (!songs || songs.length === 0) {
      return res.status(404).json({ error: 'Audio file not found in database' });
    }

    const song = songs[0];
    
    // Add Content-Type header based on format
    if (song.format) {
      const mimeTypes = {
        'mp3': 'audio/mpeg',
        'wav': 'audio/wav',
        'ogg': 'audio/ogg',
        'flac': 'audio/flac',
        'm4a': 'audio/mp4'
      };
      
      const contentType = mimeTypes[song.format.toLowerCase()] || 'audio/mpeg';
      res.set('Content-Type', contentType);
    }
    
    // Set appropriate headers
    if (req.query.download === 'true') {
      res.set('Content-Disposition', `attachment; filename="${song.filename}"`);
    } else {
      res.set('Content-Disposition', `inline; filename="${song.filename}"`);
    }
    
    // Send the binary data
    res.send(song.audio_data);
  } catch (error) {
    console.error('Error retrieving binary audio:', error);
    res.status(500).json({ error: 'Failed to retrieve binary audio data', details: error.message });
  }
});

// Initialize database and start server
(async () => {
  try {
    // Connect to the database
    await connectToDatabase();
    
    // Initialize tables
    await initializeDatabase();
    
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to initialize database:', error);
  }
})();
