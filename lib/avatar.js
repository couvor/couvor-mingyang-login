'use strict';

// 头像：处理（sharp 裁剪压缩）+ 存储（腾讯云 COS，未配置时回退本地文件）。
// 设计原则：
//   1. 不信任客户端：MIME 与扩展名仅供参考，真实格式一律用 sharp 解出的 metadata 判定，
//      并限制输入像素数（防"图片炸弹"解压后吃满内存）；
//   2. 统一输出：智能居中裁剪为正方形 + 转 WebP，体积与显示效果可控；
//   3. 机密不下沉：密钥只在 config 内传递，永不进日志或返回给前端。

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

const config = require('../config');

class AvatarError extends Error {
  constructor(message, code = 'fail') {
    super(message);
    this.code = code;
  }
}

// ---------- 依赖惰性加载：缺少组件时给出可读错误，而不是启动即崩 ----------

let sharpLib = null;
function sharp() {
  if (sharpLib) return sharpLib;
  try {
    sharpLib = require('sharp');
  } catch {
    throw new AvatarError('服务端图片处理组件未就绪，头像功能暂不可用。', 'fail');
  }
  return sharpLib;
}

let cosClient = null;
function cos() {
  if (cosClient) return cosClient;
  try {
    const COS = require('cos-nodejs-sdk-v5');
    cosClient = new COS({
      SecretId: config.avatar.secretId,
      SecretKey: config.avatar.secretKey,
      // 上传失败自动重试一次，覆盖网络抖动；不做无限重试以免请求挂死
      FileParallelLimit: 1,
      RetryTimes: 1,
    });
  } catch {
    throw new AvatarError('对象存储客户端未就绪，头像功能暂不可用。', 'fail');
  }
  return cosClient;
}

// ---------- 存储后端 ----------

const LOCAL_NAME_RE = /^\d{1,10}-[0-9a-f]{24}\.webp$/;

function objectKey(userId) {
  // 对象键：avatars/<userId>/<24 字节随机 hex>.webp（随机后缀避免 CDN / 浏览器缓存旧图）
  return `avatars/${userId}/${crypto.randomBytes(12).toString('hex')}.webp`;
}

// 本地回退：对象键含目录分隔符，落成单文件名，避免创建多级目录与路径穿越风险
function localName(key) {
  return key.replace(/\//g, '-');
}

function publicUrl(key) {
  const { backend, publicBase } = config.avatar;
  if (backend === 'cos') return `${publicBase}/${key}`;
  // 本地模式给客户端的必须是绝对地址（学桥等 SSO 客户端要用）
  return `${config.baseUrl.replace(/\/+$/, '')}/avatar/${localName(key)}`;
}

async function putObject(key, body) {
  if (config.avatar.backend === 'local') {
    const dir = config.avatar.localDir;
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, localName(key)), body);
    return;
  }
  await cos().putObject({
    Bucket: config.avatar.bucket,
    Region: config.avatar.region,
    Key: key,
    Body: body,
    ContentType: 'image/webp',
    // 对象键含随机后缀 ⇒ 可以放心长缓存
    Headers: { 'Cache-Control': 'public, max-age=31536000' },
  });
}

// 删除旧对象。存储侧失败只记日志、不影响主流程（头像换新已成功，残留属可清理垃圾）。
async function removeObject(key) {
  if (!key) return;
  try {
    if (config.avatar.backend === 'local') {
      await fsp.rm(path.join(config.avatar.localDir, localName(key)), { force: true });
      return;
    }
    await cos().deleteObject({
      Bucket: config.avatar.bucket,
      Region: config.avatar.region,
      Key: key,
    });
  } catch (e) {
    console.warn('[loginapp] 旧头像清理失败（忽略）:', e && e.message ? e.message : e);
  }
}

// ---------- 上传限频（每用户每小时 N 次，内存计数） ----------

const uploadHits = new Map(); // userId -> number[]（毫秒时间戳）

function rateLimitOk(userId, limit = config.avatar.perHourPerUser, windowMs = 3600 * 1000) {
  const now = Date.now();
  const arr = (uploadHits.get(userId) || []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) {
    uploadHits.set(userId, arr);
    return false;
  }
  arr.push(now);
  uploadHits.set(userId, arr);
  // 顺带回收长期不活跃的条目，避免 Map 无限增长
  if (uploadHits.size > 5000) {
    for (const [k, v] of uploadHits) {
      if (v.every((t) => now - t >= windowMs)) uploadHits.delete(k);
    }
  }
  return true;
}

// ---------- 图像处理 + 落库 ----------

/**
 * 只做图像处理（校验格式 → 按 EXIF 摆正 → 智能居中裁剪 → 转 WebP），不落存储。
 * 供自检脚本做 dry-run，也便于单独验证处理链路。
 * @throws {AvatarError} code: type | fail
 */
async function processImage(buffer) {
  const lib = sharp();
  const decodeOpts = {
    // 限制输入像素（≈4000 万像素 / 约 8000×5000），挡住超大图与解压炸弹
    limitInputPixels: 40_000_000,
    animated: false, // GIF / WebP 动图只取首帧，避免动图体积失控
  };

  let meta;
  try {
    meta = await lib(buffer, decodeOpts).metadata();
  } catch {
    throw new AvatarError('无法识别该图片，可能已损坏，请换一张。', 'type');
  }

  const format = String(meta.format || '');
  if (!config.avatar.allowedFormats.includes(format)) {
    // 明确拒绝 svg：SVG 可携带脚本，是常见的存储型 XSS 载体
    throw new AvatarError('仅支持 JPG / PNG / WebP / GIF / AVIF 格式的图片。', 'type');
  }

  let out;
  try {
    out = await lib(buffer, decodeOpts)
      .rotate() // 按 EXIF 摆正手机竖拍照片
      .resize(config.avatar.size, config.avatar.size, {
        fit: 'cover',
        position: 'attention', // 智能居中：优先保留人脸等高关注区域
      })
      .webp({ quality: 82, effort: 4 })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new AvatarError('图片处理失败，请换一张试试。', 'fail');
  }

  return { data: out.data, format, width: out.info.width, height: out.info.height };
}

/**
 * 处理并保存头像。
 * @returns {Promise<{key:string, url:string, bytes:number, format:string}>}
 * @throws {AvatarError} code: nofile | toobig | type | fail | rate
 */
async function saveAvatar(userId, buffer) {
  if (!buffer || buffer.length === 0) {
    throw new AvatarError('请先选择一张图片。', 'nofile');
  }
  if (buffer.length > config.avatar.maxBytes) {
    throw new AvatarError(
      `图片不能超过 ${Math.floor(config.avatar.maxBytes / 1024 / 1024)}MB，请压缩后再试。`,
      'toobig'
    );
  }
  if (!rateLimitOk(userId)) {
    throw new AvatarError('上传过于频繁，请稍后再试。', 'rate');
  }

  const { data, format } = await processImage(buffer);
  const out = { data };

  const key = objectKey(userId);
  await putObject(key, out.data);
  return {
    key,
    url: publicUrl(key),
    bytes: out.data.length,
    format,
  };
}

// 更换头像后清理旧对象（先写新后删旧，任何一步失败都不会让用户丢头像）
async function removeAfterReplace(oldKey) {
  await removeObject(oldKey);
}

// 本地回退模式下读取文件（供 GET /avatar/:name 使用）
async function readLocal(name) {
  if (config.avatar.backend !== 'local') return null;
  if (!LOCAL_NAME_RE.test(name)) return null;
  try {
    return await fsp.readFile(path.join(config.avatar.localDir, name));
  } catch {
    return null;
  }
}

// 头像展示用：无头像时返回 null，由页面渲染首字母占位，不依赖任何第三方头像服务
function initialOf(username) {
  const s = String(username || '').trim();
  return s ? s.slice(0, 1).toUpperCase() : '?';
}

module.exports = {
  AvatarError,
  processImage,
  saveAvatar,
  removeAfterReplace,
  removeObject,
  readLocal,
  publicUrl,
  initialOf,
  LOCAL_NAME_RE,
};
