'use strict';

// 数据库层：MySQL（mysql2/promise）。
// 2026-10-20 从 SQLite（node:sqlite 同步 API）迁到 MySQL，对外保留 db.prepare(sql)
// 的调用形状（.run/.get/.all），但这三个方法**都是异步的**，调用处必须 await。
// 保留形状的原因：全站约 100 处调用点，只加 await 的改动面最小、最容易核对。

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('../config');

const SCHEMA_FILE = path.join(__dirname, '..', 'scripts', 'schema.mysql.sql');

const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  charset: 'utf8mb4',
  connectionLimit: config.db.connectionLimit,
  waitForConnections: true,
  queueLimit: 0,
  // 时间列是 VARCHAR 的 ISO 串，不需要 mysql2 做日期转换
  dateStrings: true,
});

// schema.mysql.sql 里每个语句都以「单独一行的分号」结尾，按行切分即可（无存储过程/触发器）。
function splitStatements(sql) {
  return sql
    .split(/\r?\n/)
    .filter((line) => !/^\s*--/.test(line))
    .join('\n')
    .split(/;[ \t]*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function initSchema() {
  const sql = fs.readFileSync(SCHEMA_FILE, 'utf8');
  const statements = splitStatements(sql);
  for (const stmt of statements) {
    await pool.query(stmt);
  }
  return statements.length;
}

// 所有查询都等这个 promise，确保建表先于任何读写。
const ready = initSchema().catch((err) => {
  console.error('[loginapp] 初始化 MySQL 表结构失败:', err.message);
  throw err;
});

function prepare(sql) {
  return {
    // 返回 { changes, lastInsertRowid }，与原 node:sqlite 的 StatementResult 对齐
    async run(...params) {
      await ready;
      const [r] = await pool.query(sql, params);
      return { changes: r.affectedRows || 0, lastInsertRowid: r.insertId || 0 };
    },
    async get(...params) {
      await ready;
      const [rows] = await pool.query(sql, params);
      return rows[0];
    },
    async all(...params) {
      await ready;
      const [rows] = await pool.query(sql, params);
      return rows;
    },
  };
}

const nowIso = () => new Date().toISOString();

async function cleanupExpiredSessions() {
  await prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
  // 顺带清理过期限频窗口与已过期 SSO 票据
  await prepare('DELETE FROM login_fails WHERE window_start < ?').run(
    new Date(Date.now() - config.rateLimit.windowMs * 2).toISOString()
  );
  await prepare('DELETE FROM register_fails WHERE window_start < ?').run(
    new Date(Date.now() - 2 * 3600 * 1000).toISOString()
  );
  await prepare('DELETE FROM sso_tickets WHERE expires_at < ?').run(
    new Date(Date.now() - 24 * 3600 * 1000).toISOString()
  );
}

async function close() {
  await pool.end();
}

module.exports = { db: { prepare }, ready, nowIso, cleanupExpiredSessions, close, pool };
