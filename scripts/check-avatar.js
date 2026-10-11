#!/usr/bin/env node
'use strict';

// 头像功能自检（**只读**）：检查配置、依赖、目录权限与图像处理链路，不改动任何数据。
// 绝不做真实上传，也不打印任何密钥。
//
// 用法（须带上服务运行时的环境变量，否则看到的是「未配置 COS」的回退状态）：
//   set -a; . /etc/loginapp.env; set +a
//   NODE_PATH=/www/wwwroot/login.mingyanginfo.com/node_modules node scripts/check-avatar.js
//
// 可选：
//   --dry-run   额外生成一张测试图走一遍裁剪压缩，输出处理前后体积（仍不上传）
//   --probe     额外列出账号下的 COS 桶（需要 cos:GetService 权限，可能被 CAM 拒绝）

const fsp = require('node:fs/promises');
const path = require('node:path');
const config = require('../config');
const avatar = require('../lib/avatar');

const argv = process.argv.slice(2);
const wantDryRun = argv.includes('--dry-run');
const wantProbe = argv.includes('--probe');

const line = (k, v) => console.log(`${k.padEnd(22)} ${v}`);

async function main() {
  line('storage backend', config.avatar.backend);
  if (config.avatar.backend === 'cos') {
    line('bucket', config.avatar.bucket || '(空)');
    line('region', config.avatar.region);
    line('public base', config.avatar.publicBase);
    line('credential', config.avatar.secretId && config.avatar.secretKey ? 'configured' : 'MISSING');
  } else {
    line('local dir', config.avatar.localDir);
    line('reason', 'COS_BUCKET / 密钥未配置 → 回退本地文件存储');
  }
  line('output size', `${config.avatar.size} x ${config.avatar.size} (webp)`);
  line('upload limit', `${(config.avatar.maxBytes / 1024 / 1024).toFixed(0)} MB`);
  line('formats', config.avatar.allowedFormats.join(', '));

  // 依赖
  for (const dep of ['sharp', 'multer', 'cos-nodejs-sdk-v5']) {
    let ok = true;
    try {
      require(dep);
    } catch {
      ok = false;
    }
    line(`dep ${dep}`, ok ? 'ok' : 'MISSING');
  }

  // 本地目录可写性（仅回退模式需要）
  if (config.avatar.backend === 'local') {
    try {
      await fsp.mkdir(config.avatar.localDir, { recursive: true });
      const probe = path.join(config.avatar.localDir, '.write-probe');
      await fsp.writeFile(probe, '');
      await fsp.rm(probe, { force: true });
      line('dir writable', 'yes');
    } catch (e) {
      line('dir writable', `NO (${e && e.code ? e.code : e})`);
    }
  }

  if (wantDryRun) {
    let sharpLib;
    try {
      sharpLib = require('sharp');
    } catch {
      line('dry-run', 'skipped (sharp 未安装)');
    }
    if (sharpLib) {
      const src = await sharpLib({
        create: { width: 1200, height: 800, channels: 3, background: { r: 60, g: 110, b: 234 } },
      })
        .jpeg({ quality: 92 })
        .toBuffer();
      const out = await avatar.processImage(src);
      line('dry-run input', `${(src.length / 1024).toFixed(1)} KB (1200x800 jpeg)`);
      line('dry-run output', `${(out.data.length / 1024).toFixed(1)} KB (${out.width}x${out.height} webp)`);
    }
  }

  if (wantProbe && config.avatar.backend === 'cos') {
    try {
      const COS = require('cos-nodejs-sdk-v5');
      const cos = new COS({
        SecretId: config.avatar.secretId,
        SecretKey: config.avatar.secretKey,
      });
      const data = await cos.getService({ Region: config.avatar.region });
      const buckets = (data && data.Buckets) || [];
      line('buckets', String(buckets.length));
      for (const b of buckets) line('  -', `${b.Name} @ ${b.Location}`);
    } catch (e) {
      line('buckets', `无法列出（${e && e.code ? e.code : 'error'}，多为 CAM 未授权 cos:GetService）`);
    }
  }
}

main().catch((e) => {
  console.error('[check-avatar] 失败:', e);
  process.exit(1);
});
