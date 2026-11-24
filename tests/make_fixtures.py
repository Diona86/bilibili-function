"""Regenerate the small, original test clips with FFmpeg 7 (pass the executable as argv[1])."""
from pathlib import Path
import subprocess
import sys

directory = Path(__file__).resolve().parent / "fixtures"
directory.mkdir(exist_ok=True)
ffmpeg = sys.argv[1] if len(sys.argv) > 1 else "ffmpeg"


def encode(*arguments):
    subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", *arguments],
                   cwd=directory, check=True)


def write(name, value):
    (directory / name).write_text(value, encoding="utf-8", newline="\n")


encode("-f", "lavfi", "-i", "testsrc2=size=96x64:rate=8:duration=2",
       "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
       "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "8", "-bf", "0", "-sc_threshold", "0",
       "-c:a", "aac", "-b:a", "32k", "-movflags", "+faststart", "clip.mp4")
encode("-i", "clip.mp4", "-c:v", "libvpx-vp9", "-c:a", "libopus", "-b:a", "24k", "clip.webm")
encode("-i", "clip.mp4", "-c", "copy", "clip.mov")
encode("-i", "clip.mp4", "-c", "copy", "clip.mkv")
encode("-i", "clip.mp4", "-c:v", "libtheora", "-c:a", "libvorbis", "clip.ogv")
encode("-i", "clip.mp4", "-c", "copy", "-hls_time", "1", "-hls_list_size", "0", "ts.m3u8")
encode("-i", "clip.mp4", "-c", "copy", "-hls_flags", "single_file", "-hls_time", "1", "-hls_list_size", "0", "range.m3u8")
for name, args in [("high", ["-an", "-c:v", "copy"]), ("low", ["-an", "-vf", "scale=72:48,setsar=1", "-c:v", "libx264", "-bf", "0", "-g", "8"]),
                   ("audio", ["-vn", "-c:a", "copy"])]:
    encode("-i", "clip.mp4", *args, "-hls_time", "1", "-hls_list_size", "0", "-hls_segment_type", "fmp4",
           "-hls_fmp4_init_filename", name+"-init.mp4", name+".m3u8")
encode("-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=2", "-c:a", "aac", "-b:a", "32k", "second.m4a")
encode("-i", "second.m4a", "-c", "copy", "-hls_time", "1", "-hls_list_size", "0", "-hls_segment_type", "fmp4",
       "-hls_fmp4_init_filename", "second-init.mp4", "second.m3u8")
encode("-i", "clip.mp4", "-i", "second.m4a", "-map", "0:v", "-map", "0:v", "-map", "0:a", "-map", "1:a", "-c", "copy",
       "-c:v:1", "libx264", "-filter:v:1", "scale=72:48,setsar=1", "-g:v:1", "8", "-bf:v:1", "0",
       "-f", "dash", "-seg_duration", "1", "-use_timeline", "1", "-use_template", "1",
       "-metadata:s:a:0", "language=eng", "-metadata:s:a:1", "language=jpn",
       "-adaptation_sets", "id=0,streams=v id=1,streams=2 id=2,streams=3", "movie.mpd")
write("master.m3u8", """#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Tone",LANGUAGE="en",DEFAULT=YES,URI="audio.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Second tone",LANGUAGE="ja",URI="second.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="字幕",LANGUAGE="zh",URI="subs.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=150000,RESOLUTION=96x64,FRAME-RATE=8,CODECS="avc1.64000a,mp4a.40.2",AUDIO="a",SUBTITLES="s"
high.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=90000,RESOLUTION=72x48,FRAME-RATE=8,CODECS="avc1.64000a,mp4a.40.2",AUDIO="a",SUBTITLES="s"
low.m3u8
""")
write("one.vtt", "WEBVTT\n\n00:00.000 --> 00:00.900\n第一段\n")
write("two.vtt", "WEBVTT\n\n00:01.000 --> 00:01.900\n第二段\n")
write("caption.srt", "1\n00:00:00,000 --> 00:00:00,900\n原始字幕\n")
write("subs.m3u8", "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\none.vtt\n#EXTINF:1,\ntwo.vtt\n#EXT-X-ENDLIST\n")
