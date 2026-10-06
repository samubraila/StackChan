// SPDX-License-Identifier: MIT
// Draws the StackChan default avatar on a canvas.
// Geometry follows firmware/main/stackchan/avatar/skins/default/{eyes,mouth}.cpp
// on the robot's 320x240 screen.
'use strict';

(function () {
  const SCREEN_W = 320;
  const SCREEN_H = 240;

  const EYE_POS = { x: -70, y: -16 };
  const EYE_OFFSET = 16; // eye position x/y of ±100 moves the eye by ±16 px
  const EYE_SIZE = { min: 8, max: 32 }; // size -100..100

  const MOUTH_POS = { x: 0, y: 26 };
  const MOUTH_OFFSET = 16;
  const MOUTH_MIN = { w: 90, h: 6, r: 0 }; // weight 0 (closed)
  const MOUTH_MAX = { w: 60, h: 50, r: 16 }; // weight 100 (wide open)

  const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));
  const mapRange = (value, inMin, inMax, outMin, outMax) =>
    outMin + ((value - inMin) * (outMax - outMin)) / (inMax - inMin);
  // Firmware rotation is in tenths of a degree.
  const toRadians = (rotation) => ((Number(rotation) || 0) / 10) * (Math.PI / 180);

  function drawEye(ctx, eye, isLeft, colors) {
    const x = clamp(eye.x, -100, 100);
    const y = clamp(eye.y, -100, 100);
    const size = mapRange(clamp(eye.size, -100, 100), -100, 100, EYE_SIZE.min, EYE_SIZE.max);
    const weight = clamp(eye.weight, 0, 100);

    const cx = SCREEN_W / 2 + (isLeft ? EYE_POS.x : -EYE_POS.x) + mapRange(x, -100, 100, -EYE_OFFSET, EYE_OFFSET);
    const cy = SCREEN_H / 2 + EYE_POS.y + mapRange(y, -100, 100, -EYE_OFFSET, EYE_OFFSET);
    // The eyelid is a background-coloured square that slides up as weight grows.
    const eyelidOffset = -mapRange(weight, 0, 100, 0, size);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(toRadians(eye.rotation));
    ctx.fillStyle = colors.feature;
    ctx.beginPath();
    ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
    ctx.fill();
    // 1px overdraw hides the anti-aliased rim of a fully closed eye.
    ctx.fillStyle = colors.background;
    ctx.fillRect(-size / 2 - 1, -size / 2 + eyelidOffset - 1, size + 2, size + 2);
    ctx.restore();
  }

  function drawMouth(ctx, mouth, colors) {
    const x = clamp(mouth.x, -100, 100);
    const y = clamp(mouth.y, -100, 100);
    const weight = clamp(mouth.weight, 0, 100);

    const w = mapRange(weight, 0, 100, MOUTH_MIN.w, MOUTH_MAX.w);
    const h = mapRange(weight, 0, 100, MOUTH_MIN.h, MOUTH_MAX.h);
    const r = mapRange(weight, 0, 100, MOUTH_MIN.r, MOUTH_MAX.r);
    const cx = SCREEN_W / 2 + MOUTH_POS.x + mapRange(x, -100, 100, -MOUTH_OFFSET, MOUTH_OFFSET);
    const cy = SCREEN_H / 2 + MOUTH_POS.y + mapRange(y, -100, 100, -MOUTH_OFFSET, MOUTH_OFFSET);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(toRadians(mouth.rotation));
    ctx.fillStyle = colors.feature;
    ctx.beginPath();
    ctx.roundRect(-w / 2, -h / 2, w, h, Math.min(r, w / 2, h / 2));
    ctx.fill();
    ctx.restore();
  }

  /** Renders `avatar` ({leftEye, rightEye, mouth}) into `canvas`, sized to its CSS box. */
  function drawFace(canvas, avatar, colors = { background: '#000', feature: '#fff' }) {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, width, height);

    const scale = Math.min(width / SCREEN_W, height / SCREEN_H);
    ctx.translate((width - SCREEN_W * scale) / 2, (height - SCREEN_H * scale) / 2);
    ctx.scale(scale, scale);

    drawEye(ctx, avatar.leftEye, true, colors);
    drawEye(ctx, avatar.rightEye, false, colors);
    drawMouth(ctx, avatar.mouth, colors);
  }

  window.StackChanFace = { drawFace, SCREEN_W, SCREEN_H };
})();
