# Payload Data Analysis - Issues and Fixes

## Issue #1: Client-Side Control Fields Leaking Into Transmitted Payload ✅ FIXED

**Problem**: The `isDragging` flag was being merged into the final payload sent to daemon.

**Before (Buggy)**:
```javascript
Object.assign(payload, options.extraPayload);  // isDragging merged in!
```

**After (Fixed)**:
```javascript
// Only merge transmittable viewport/coordinate fields
const transmittableFields = {
  viewScrollLeft: options.extraPayload.viewScrollLeft,
  viewScrollTop: options.extraPayload.viewScrollTop,
  viewWidth: options.extraPayload.viewWidth,
  viewHeight: options.extraPayload.viewHeight,
  viewSourceWidth: options.extraPayload.viewSourceWidth,
  viewSourceHeight: options.extraPayload.viewSourceHeight,
};
// Skip control flags like isDragging
```

**Result**: isDragging flag is kept local on client, not transmitted ✅

---

## Issue #2: Redundant Viewport Fields Being Transmitted

**Fields currently sent but NOT used by daemon for mapping**:
- viewScrollLeft
- viewScrollTop  
- viewWidth
- viewHeight
- viewSourceWidth
- viewSourceHeight

**Assessment**: These fields are transmitted but ignored by the coordinate mapping function. They appear to be reserved for a future viewport-aware mapping feature. Currently SAFE to keep sending (no harm, just extra data).

**Decision**: Keep these fields for now (future compatibility), but document that they're unused:
```
note: 'viewWidth/Height/scrollLeft/Top sent but not used for mapping (reserved for future viewport-aware feature)'
```

---

## Data Flow - Corrected ✅

```
CLIENT SIDE:
queueDragMove(event, {isDragging: true})
    ↓
sendMappedMouseCommand(type, event, {isDragging: true})
    ↓
fullPayload = {
  ...viewportPayload,           // viewWidth, viewHeight, viewScrollLeft, viewScrollTop
  isDragging: true              // CLIENT CONTROL FLAG
}
    ↓
sendMouseCommand(type, event, fullPayload)
    ↓
buildViewerMousePayload() with extraPayload = fullPayload
    ↓
TRANSMITTED PAYLOAD:
{
  x, y,                          // ✅ Coordinates
  sx, sy,                        // ✅ Source dimensions (when isDragging=true)
  viewWidth, viewHeight,         // ✅ Viewport info (unused but kept for future)
  viewScrollLeft, viewScrollTop, // ✅ Viewport info (unused but kept for future)
}

CLIENT KEEPS LOCAL:
{
  isDragging: true,              // ✅ Not transmitted
  moveSendInFlight: false,       // ✅ Not transmitted
}
```

---

## Transmitted Data Summary (CORRECT NOW)

### mouse_move (Non-dragging):
```json
{
  "x": 640,
  "y": 360,
  "viewWidth": 1280,
  "viewHeight": 720,
  "viewScrollLeft": 0,
  "viewScrollTop": 0
}
```
Binary format option: 11 bytes (when no viewport mapping)

### mouse_move (Dragging):
```json
{
  "x": 640,
  "y": 360,
  "sx": 1920,
  "sy": 1080,
  "viewWidth": 1280,
  "viewHeight": 720,
  "viewScrollLeft": 0,
  "viewScrollTop": 0
}
```

### mouse_click / mouse_down / mouse_up:
```json
{
  "x": 640,
  "y": 360,
  "b": 0,
  "sx": 1920,
  "sy": 1080,
  "viewWidth": 1280,
  "viewHeight": 720,
  "viewScrollLeft": 0,
  "viewScrollTop": 0
}
```

**NO isDragging or other control flags in transmitted data** ✅

---

## Validation: What Gets Logged

### Client logs:
```
[viewerUtils] Using JSON format for mouse_move {
  transmitted: { x, y, sx, sy, viewWidth, viewHeight, ... },
  clientLocal: { isDragging: true }
}
```

### Daemon logs:
```
[daemon] mouse_move received {
  received: { x, y, viewWidth, viewHeight, sx, sy, ... },
  used: { x, y, sx, sy },
  note: 'viewWidth/Height/scrollLeft/Top sent but not used for mapping'
}
```

---

## Conclusion

✅ **All necessary coordinate data is transmitted**
✅ **No client-side control flags leak into transmitted payload**
✅ **Source dimensions included for accurate mapping (especially during drag)**
✅ **Viewport fields kept for future viewport-aware feature**
✅ **Optimization maintained: binary encoding still available for simple moves**

