import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();

// Create MySQL connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD !== undefined ? process.env.DB_PASSWORD : 'root',
  database: process.env.DB_NAME || 'SoundWave',
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Test database connection
async function connectToDatabase() {
  try {
    // Test the connection by getting a connection from the pool
    const connection = await pool.getConnection();
    console.log('Successfully connected to MySQL database!');
    connection.release();
    return pool;
  } catch (error) {
    console.error('Error connecting to database:', error);
    throw error;
  }
}

// Function to execute SQL queries
async function query(sql, params) {
  try {
    const [results] = await pool.execute(sql, params);
    return results;
  } catch (error) {
    console.error('Query error:', error);
    throw error;
  }
}

// Create tables if they don't exist
async function initializeDatabase() {
  const createUsersTable = `
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(50) NOT NULL UNIQUE,
      email VARCHAR(100) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      upload_count INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    );
  `;

  const createSongsTable = `
    CREATE TABLE IF NOT EXISTS songs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      songUrl VARCHAR(255) NOT NULL,
      filePath VARCHAR(255) NOT NULL,
      filename VARCHAR(255) NOT NULL,
      language VARCHAR(50) DEFAULT 'unknown',
      language_iso VARCHAR(10) DEFAULT 'unknown',
      summary TEXT,
      explicit BOOLEAN DEFAULT FALSE,
      keywords TEXT,
      ddex_moods TEXT,
      ddex_themes TEXT,
      flags TEXT,
      embedding LONGTEXT,
      createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    );
  `;

  const createSongAudioMetadataTable = `
    CREATE TABLE IF NOT EXISTS song_audio_metadata (
      id INT AUTO_INCREMENT PRIMARY KEY,
      song_id INT NOT NULL,
      format VARCHAR(20) NOT NULL,
      bit_rate INT,
      sample_rate INT,
      duration FLOAT,
      file_size INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE
    );
  `;

  const createSongAudioFilesTable = `
    CREATE TABLE IF NOT EXISTS song_audio_files (
      id INT AUTO_INCREMENT PRIMARY KEY,
      metadata_id INT NOT NULL,
      audio_data LONGBLOB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (metadata_id) REFERENCES song_audio_metadata(id) ON DELETE CASCADE
    );
  `;

  try {
    // Create tables in correct order to maintain foreign key relationships
    await query(createUsersTable);
    await query(createSongsTable);
    await query(createSongAudioMetadataTable);
    await query(createSongAudioFilesTable);
    
    // Check if user_id column exists in songs table
    const checkColumnSql = `
      SELECT COUNT(*) as column_exists 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = DATABASE() 
      AND TABLE_NAME = 'songs' 
      AND COLUMN_NAME = 'user_id';
    `;
    
    const columnCheck = await query(checkColumnSql);
    
    // If user_id column doesn't exist, add it
    if (columnCheck[0].column_exists === 0) {
      try {
        // Add user_id column
        const addColumnSql = `
          ALTER TABLE songs
          ADD COLUMN user_id INT;
        `;
        await query(addColumnSql);
        
        // Add foreign key constraint
        const addForeignKeySql = `
          ALTER TABLE songs
          ADD CONSTRAINT fk_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
        `;
        await query(addForeignKeySql);
        
        console.log('User ID column added to songs table');
      } catch (alterError) {
        console.error('Error adding user_id column:', alterError);
        // Continue execution even if this fails, as the main tables are created
      }
    } else {
      console.log('User ID column already exists in songs table');
    }
    
    console.log('All database tables initialized');
  } catch (error) {
    console.error('Failed to initialize database tables:', error);
    throw error;
  }
}

export { pool, connectToDatabase, query, initializeDatabase };
