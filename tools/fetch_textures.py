import json, os, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor
from PIL import Image
OUT = os.path.join(os.path.dirname(__file__), 'texcache')
# id -> resolution
TEX = {
 'beige_wall_002':'2k','worn_plaster_wall':'2k','plaster_stone_wall_01':'2k','stone_wall_03':'2k',
 'sandy_gravel':'2k','cobblestone_04':'2k','dry_ground_01':'2k',
 'weathered_planks':'1k','rough_wood':'1k','wood_planks_dirt':'1k',
 'rusty_metal_02':'1k','green_metal_rust':'1k','blue_painted_planks':'1k','corrugated_iron_02':'1k','concrete_pavement':'2k','worn_asphalt':'2k',
}
MAPS = {'Diffuse':'diff','nor_gl':'nor','Rough':'rough','AO':'ao'}
def get(url):
    req = urllib.request.Request(url, headers={'User-Agent':'cs2-dust2-build'})
    return urllib.request.urlopen(req, timeout=120).read()
def fetch(tid, res):
    files = json.loads(get(f'https://api.polyhaven.com/files/{tid}'))
    got = {}
    for k, short in MAPS.items():
        if k not in files: continue
        r = res if res in files[k] else sorted(files[k].keys())[0]
        fmt = 'jpg' if 'jpg' in files[k][r] else list(files[k][r].keys())[0]
        url = files[k][r][fmt]['url']
        dst = os.path.join(OUT, f'{tid}_{short}.{fmt}')
        if not os.path.exists(dst):
            open(dst,'wb').write(get(url))
        got[short] = dst
    # premultiply AO into diffuse
    if 'ao' in got and 'diff' in got:
        dst = os.path.join(OUT, f'{tid}_diffao.jpg')
        if not os.path.exists(dst):
            d = Image.open(got['diff']).convert('RGB'); a = Image.open(got['ao']).convert('L').resize(d.size)
            # soften AO (lerp toward white) so it doesn't overdarken
            a = Image.eval(a, lambda v: int(128 + v*0.5))
            from PIL import ImageChops
            m = ImageChops.multiply(d, Image.merge('RGB',(a,a,a)))
            m.save(dst, quality=90)
        got['diff'] = dst
    return tid, got
with ThreadPoolExecutor(6) as ex:
    for tid, got in ex.map(lambda kv: fetch(*kv), TEX.items()):
        print(tid, {k: os.path.basename(v) for k,v in got.items()})
