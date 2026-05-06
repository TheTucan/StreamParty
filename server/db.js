'use strict';
const mysql = require('mysql2/promise');
const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER || 'streamparty',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'streamparty',
  waitForConnections: true,
  connectionLimit: 20,
  queueLimit: 0,
  timezone: 'Z',
  charset: 'utf8mb4',
});
pool.q = (sql, params) => pool.query(sql, params);
pool.ex = async (sql, params) => { const [rows] = await pool.query(sql, params); return rows; };
pool.one = async (sql, params) => { const rows = await pool.ex(sql, params); return rows[0] || null; };
module.exports = pool;
