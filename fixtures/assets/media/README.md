`still.webm`: two seconds of SMPTE colour bars that never change (VP8, 320x180, no audio), so a
screenshot of it is the same whichever frame is showing. Made with

```
ffmpeg -f lavfi -i "smptebars=size=320x180:rate=10:duration=2" -c:v libvpx -b:v 200k -an still.webm
```
