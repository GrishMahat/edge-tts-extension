# Firefox Compatibility Guide

This document outlines the key differences between Firefox and Chrome when working with WebSocket audio streaming, MediaSource API, and cross-compartment security in browser extensions.

## Issues Encountered and Solutions

### 1. MediaSource Audio Format Incompatibility

**Problem:**
Firefox does not support MP3 format (`audio/mpeg`) in MediaSource API for our use case. Attempting to use it results in:
```
DOMException: MediaSource.addSourceBuffer: Type not supported in MediaSource
```

**Solution:**
Use WebM/Opus format for Firefox, MP3 for Chrome:
```typescript
// In browserCommunicate.ts
const outputFormat = isFirefox()
  ? 'webm-24khz-16bit-mono-opus'
  : 'audio-24khz-48kbitrate-mono-mp3';

// In contentScript.ts
const mimeType = isFirefox()
  ? 'audio/webm; codecs="opus"'
  : 'audio/mpeg';
sourceBuffer = mediaSource.addSourceBuffer(mimeType);
```

### 2. Cross-Compartment ArrayBuffer Security

**Problem:**
Firefox has strict security boundaries (compartments) between different JavaScript contexts. When `FileReader.result` returns an `ArrayBuffer` from a WebSocket Blob message, accessing it triggers:
```
Error: Permission denied to access property "constructor"
TypeError: can't access property "startsWith", r is undefined
```

This happens because:
- `instanceof ArrayBuffer` checks fail across compartments
- Passing cross-compartment ArrayBuffers to constructors fails
- The standard `data.arrayBuffer()` Promise method fails with "non-unwrappable cross-compartment wrapper"

**Solution:**
Use FileReader API and manually copy bytes instead of using `.arrayBuffer()`:
```typescript
} else if (data instanceof Blob) {
  const reader = new FileReader();
  reader.onload = () => {
    const arrayBuffer = reader.result as ArrayBuffer;

    // Manual byte-by-byte copy to avoid constructor issues
    const byteLength = (arrayBuffer as any).byteLength;
    const bufferData = new Uint8Array(byteLength);
    const sourceView = new Uint8Array(arrayBuffer);
    for (let i = 0; i < byteLength; i++) {
      bufferData[i] = sourceView[i];
    }

    // Now safe to use bufferData
    const [headers, audioData] = browserGetHeadersAndDataFromBinary(bufferData);
    // ...
  };
  reader.readAsArrayBuffer(data);
}
```

**Why this works:**
- Creates a fresh `Uint8Array` in the content script's compartment
- Manually copies each byte, avoiding constructor checks
- The new array is "native" to the current compartment

### 3. Content-Type Header Variations

**Problem:**
Microsoft's TTS API returns different Content-Type formats:
- With codec: `audio/webm; codec=opus`
- Without codec: `audio/webm`
- Sometimes missing entirely: `undefined`

Simple equality checks fail, causing valid audio to be rejected.

**Solution:**
Use flexible validation that accepts codec parameters and handles missing headers:
```typescript
const contentType = headers['Content-Type'] || '';
const isValidAudio = contentType === 'audio/mpeg' ||
                     contentType.startsWith('audio/webm') ||
                     contentType === 'audio/webm';

if (!isValidAudio && contentType) {
  // Only error if there's a Content-Type and it's not valid
  // Missing Content-Type is acceptable
}
```

### 4. Empty Audio Chunks

**Problem:**
Microsoft's API sends empty binary messages (0 bytes of audio after headers) as end-of-stream markers. Treating these as errors causes:
```
UnexpectedResponse: Received binary message, but it is missing the audio data.
```

**Solution:**
Silently ignore empty audio chunks:
```typescript
} else if (audioData.length === 0) {
  // Ignore empty audio chunks (normal at end of stream)
  // Do nothing - this is expected behavior
} else {
  messageQueue.push({ type: 'audio', data: audioData });
}
```

### 5. FileReader Promise Resolution Loop

**Problem:**
When using FileReader with async message processing, the `resolveMessage` callback can be called multiple times, causing the same Blob to be processed infinitely:
```
[Firefox Debug] Total blob size: 268 Headers: {...} Audio data size: 126
[Firefox Debug] Total blob size: 268 Headers: {...} Audio data size: 126
[Firefox Debug] Total blob size: 268 Headers: {...} Audio data size: 126
// ... repeats infinitely
```

**Solution:**
Nullify the resolver after calling it to prevent double-resolution:
```typescript
reader.onload = () => {
  // ... process blob ...

  if (resolveMessage) {
    resolveMessage();
    resolveMessage = null; // Prevent double resolution
  }
};

// Don't call resolveMessage() after starting FileReader
reader.readAsArrayBuffer(data);
return; // Exit early
```

### 6. WebM Stream Concatenation Issue

**Problem:**
When text is split into multiple chunks (e.g., 4KB each), each chunk creates a new WebSocket connection and receives a **complete, self-contained WebM file** with its own header and metadata.

Concatenating multiple complete WebM files creates an invalid stream:
```
WebM Header (28 bytes) + Audio Data → [Valid]
WebM Header (28 bytes) + Audio Data → [Invalid when appended to previous]
```

Firefox's decoder fails with:
```
Media resource could not be decoded
Error Code: NS_ERROR_DOM_MEDIA_METADATA_ERR (0x806e0006)
```

**Why Chrome was less affected:**
Chrome uses MP3 format, which is more forgiving of concatenation since MP3 frames are relatively independent. WebM/Opus requires proper container structure.

**Solution:**
Use much larger chunk sizes for Firefox to avoid splitting text:
```typescript
// In browserCommunicate.ts constructor
const chunkSize = isFirefox() ? 32768 : 4096; // 32KB vs 4KB

this.texts = browserSplitTextByByteLength(
  escape(removeIncompatibleCharacters(text)),
  chunkSize,
);
```

**Why 32KB:**
- Most texts fit in a single chunk, avoiding the concatenation issue entirely
- 8x larger than Chrome's 4KB, handling much longer content
- Still within Microsoft's API limits
- Simple workaround vs complex WebM stream merging

**Alternative Solutions (not implemented):**
1. Strip WebM headers from subsequent chunks (complex, fragile)
2. Reuse single WebSocket for all chunks (requires rewriting `_stream()` architecture)
3. Remux WebM streams into single container (requires WebM parser/muxer)

### 7. Firefox-Specific MediaSource Behavior

**Observations:**
- Firefox is stricter about MediaSource state transitions
- Requires proper MIME type with codec: `audio/webm; codecs="opus"` (note: plural "codecs")
- More aggressive about closing MediaSource when encountering invalid data
- Less forgiving of malformed container formats compared to Chrome

## Implementation Checklist

When implementing WebSocket audio streaming for Firefox:

- [ ] Detect browser and use appropriate audio format (WebM for Firefox, MP3 for Chrome)
- [ ] Use FileReader API for Blob messages instead of `.arrayBuffer()`
- [ ] Manually copy bytes from cross-compartment ArrayBuffers
- [ ] Accept Content-Type variations (with/without codec parameters)
- [ ] Handle missing Content-Type headers gracefully
- [ ] Ignore empty audio chunks (end-of-stream markers)
- [ ] Prevent FileReader callback loops with resolver nullification
- [ ] Use larger chunk sizes for Firefox (32KB recommended)
- [ ] Set correct MIME type in MediaSource.addSourceBuffer()
- [ ] Test with various text lengths to ensure no splitting occurs

## Key Files Modified

1. **src/utils/browserCommunicate.ts**
   - Browser detection for audio format selection
   - FileReader-based Blob handling
   - Manual byte copying for cross-compartment safety
   - Flexible Content-Type validation
   - Larger chunk size for Firefox

2. **src/contentScript.ts**
   - Browser-specific MIME type for MediaSource
   - Firefox-specific autoplay handling

3. **src/utils/browserDetection.ts**
   - Browser detection utilities

## Testing Firefox Compatibility

To verify Firefox compatibility:

1. Test with short text (< 4KB) - should work in single chunk
2. Test with medium text (4KB - 32KB) - should work in single chunk for Firefox
3. Test with long text (> 32KB) - may still have issues, needs investigation
4. Check console for errors related to:
   - MediaSource format support
   - Cross-compartment security
   - WebSocket message processing
5. Verify audio plays without interruption
6. Test "Read from Here" and "Read Page" functionality

## Performance Considerations

**Trade-offs of 32KB chunks:**
- ✅ Avoids WebM concatenation issues
- ✅ Reduces number of WebSocket connections
- ✅ Simpler implementation
- ⚠️ May hit API limits for very long texts
- ⚠️ Longer initial delay before playback starts (waiting for complete chunk)

**Memory implications:**
- Manual byte copying doubles memory usage temporarily
- Each audio chunk is cloned before appending to MediaSource
- Acceptable overhead for typical TTS use cases (< 1MB per request)

## Future Improvements

Potential enhancements for better Firefox support:

1. **WebM Stream Merger**: Implement proper WebM muxer to merge multiple streams
2. **Persistent WebSocket**: Reuse single WebSocket connection for all chunks
3. **Adaptive Chunking**: Dynamically adjust chunk size based on text length
4. **Streaming Detection**: Detect when text will be split and warn user
5. **Progressive Loading**: Start playback while still receiving chunks (requires WebM expertise)

## References

- [MDN: MediaSource API](https://developer.mozilla.org/en-US/docs/Web/API/MediaSource)
- [MDN: FileReader API](https://developer.mozilla.org/en-US/docs/Web/API/FileReader)
- [Firefox Cross-Compartment Security](https://firefox-source-docs.mozilla.org/dom/scriptSecurity/index.html)
- [WebM Format Specification](https://www.webmproject.org/docs/container/)
- [Microsoft Edge TTS API](https://docs.microsoft.com/en-us/azure/cognitive-services/speech-service/)