import json, sys, soundfile as sf
from kokoro_onnx import Kokoro
voice = sys.argv[1]; out = sys.argv[2]
k = Kokoro("kokoro.onnx", "voices.bin")
lines = json.load(open("/home/claude/acan/video/renderer/voice/lines.json"))
res = []
for l in lines:
    a, sr = k.create(l["text"], voice=voice, speed=1.0, lang="en-us")
    sf.write(f"{out}/{l['id']}.wav", a, sr)
    res.append({"id": l["id"], "at": l["at"], "dur": round(len(a)/sr, 2), "end": round(l["at"] + len(a)/sr, 2)})
print(json.dumps(res))
