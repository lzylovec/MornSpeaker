import { WebSocketServer } from 'ws';
import { createHmac } from 'crypto';
import { IncomingMessage } from 'http';
import { WebSocket } from 'ws';
import fs from 'fs';
import path from 'path';

export const runtime = 'nodejs'; // Ensure Node.js runtime for crypto

// 腾讯云鉴权逻辑
function getAuthSignature(params: Record<string, any>, secretKey: string, appId: string) {
  const sortedKeys = Object.keys(params).sort();
  let strParam = '';
  for (const key of sortedKeys) {
    strParam += `${key}=${params[key]}&`;
  }
  strParam = strParam.slice(0, -1);
  const signStr = `GETasr.cloud.tencent.com/asr/v2/${appId}?${strParam}`;

  // 使用 top-level import 的 createHmac
  return createHmac('sha1', secretKey).update(signStr).digest('base64');
}

export async function POST(req: Request) {
  // DEBUG: 使用环境变量配置，避免密钥泄漏
  // 优先使用 ASR 专用配置，如果不存在则回退到通用配置
  const secretId = process.env.TENCENT_ASR_SECRET_ID || process.env.TENCENT_SECRET_ID;
  const secretKey = process.env.TENCENT_ASR_SECRET_KEY || process.env.TENCENT_SECRET_KEY;
  const appId = process.env.TENCENT_ASR_APP_ID || process.env.TENCENT_APP_ID;

  if (!secretId || !secretKey || !appId) {
    return new Response(JSON.stringify({ error: "Missing Tencent Cloud credentials (SecretId/SecretKey/AppId)" }), { status: 500 });
  }

  const url = new URL(req.url);
  const action = url.searchParams.get('action');

  if (action === 'get_signature') {
    const timestamp = Math.floor(Date.now() / 1000);
    const debugVoiceId = 'debug_voice_id_' + Math.random().toString(36).substring(7);

    const params: Record<string, any> = {
      'secretid': secretId,
      'timestamp': timestamp,
      'expired': timestamp + 3600,
      'nonce': Math.floor(Math.random() * 100000),
      'engine_model_type': '16k_zh',
      'voice_id': debugVoiceId,
      'voice_format': 8,
      'needvad': 1,
      'vad_silence_time': 2000,
      'punc': 0,
      'filter_dirty': 1,
      'filter_modal': 1,
      'filter_punc': 0,
      'convert_num_mode': 1,
      'word_info': 0,
    };

    const signature = getAuthSignature(params, secretKey, appId);

    // 构造完整 URL
    let queryParams = '';
    const sortedKeys = Object.keys(params).sort();
    let signStrForDebug = `GETasr.cloud.tencent.com/asr/v2/${appId}?`;

    for (const key of sortedKeys) {
      queryParams += `${key}=${encodeURIComponent(String(params[key]))}&`;
      signStrForDebug += `${key}=${params[key]}&`;
    }

    const encodedSignature = encodeURIComponent(signature);
    queryParams += `signature=${encodedSignature}`;
    signStrForDebug = signStrForDebug.slice(0, -1);

    // 生成 curl 命令用于调试
    const wsUrl = `wss://asr.cloud.tencent.com/asr/v2/${appId}?${queryParams}`;
    // 注意：curl 不支持 wss，通常用 websocat 或只验证 handshake
    // 这里生成一个打印 URL 的命令
    const debugCurl = `curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Host: asr.cloud.tencent.com" -H "Origin: https://asr.cloud.tencent.com" "${wsUrl.replace('wss://', 'https://')}"`;

    const debugInfo = {
      voiceId: debugVoiceId,
      secretKeyLength: secretKey.length,
      signStr: signStrForDebug,
      signature: signature,
      encodedSignature: encodedSignature,
      debugCurl: debugCurl,
      timestamp: new Date().toISOString()
    };

    console.error('[ASR Signature Debug]', debugInfo);

    // Write debug info to public file for easy access - REMOVED for security
    // The debug info is already logged to console above and returned in response below

    return new Response(JSON.stringify({
      wsUrl,
      signature,
      signStr: signStrForDebug,
      debugCurl, // 返回给前端打印
      ...params,
      appid: appId
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (action === 'get_android_config') {
    return new Response(JSON.stringify({
      appId: appId,
      secretId: secretId,
      secretKey: secretKey
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  return new Response("Invalid action", { status: 400 });
}
