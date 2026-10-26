# Lager bildene til bilder.html fra en mappe med originaler, ordnet i undermapper per år (2025, 2026, 2027).
# Hvert bilde blir to webp-filer uten metadata (ingen GPS): en liten til rutenettet og en stor til fullskjerm.
# Rekkefølgen følger tallet foran filnavnet (1-DSC00537.jpg) og ellers filnavnet.
# Bruk: python3 scripts/lag-bilder.py <mappe med originaler>
import json, os, re, sys
from concurrent.futures import ProcessPoolExecutor
from PIL import Image, ImageOps

KILDE = sys.argv[1]
UT = 'bilder'
LITEN, STOR = 800, 1800  # bredde i rutenettet, lengste side i fullskjerm
TYPER = ('.jpg', '.jpeg', '.png', '.webp')


def rekkefolge(f):
    m = re.match(r'(\d+)-', f)
    return (int(m.group(1)) if m else 10**9, f.lower())


def lag(jobb):
    kilde, aar, nr, f = jobb
    navn = '%03d-%s' % (nr, re.sub(r'[^a-z0-9]+', '-', os.path.splitext(re.sub(r'^\d+-', '', f))[0].lower()).strip('-'))
    im = ImageOps.exif_transpose(Image.open(os.path.join(kilde, aar, f))).convert('RGB')
    stor = im.copy(); stor.thumbnail((STOR, STOR), Image.LANCZOS)
    liten = im.copy(); liten.thumbnail((LITEN, LITEN * 3), Image.LANCZOS)
    stor.save(os.path.join(UT, aar, navn + '.webp'), 'WEBP', quality=80, method=4)
    liten.save(os.path.join(UT, aar, navn + '-liten.webp'), 'WEBP', quality=78, method=4)
    return aar, nr, [navn, liten.width, liten.height]


if __name__ == '__main__':
    jobber, data = [], {}
    for aar in sorted(os.listdir(KILDE)):
        if not re.fullmatch(r'\d{4}', aar):
            continue
        os.makedirs(os.path.join(UT, aar), exist_ok=True)
        filer = sorted((f for f in os.listdir(os.path.join(KILDE, aar)) if f.lower().endswith(TYPER)), key=rekkefolge)
        data[aar] = [None] * len(filer)
        jobber += [(KILDE, aar, i + 1, f) for i, f in enumerate(filer)]
    with ProcessPoolExecutor() as p:
        for aar, nr, rad in p.map(lag, jobber):
            data[aar][nr - 1] = rad
    with open(os.path.join(UT, 'bilder.json'), 'w') as f:
        json.dump(data, f, separators=(',', ':'))
    print({a: len(v) for a, v in data.items()})
