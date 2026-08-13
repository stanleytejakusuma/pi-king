import glob, json, numpy as np
from PIL import Image
from scipy import ndimage
files = sorted(glob.glob('/tmp/pi-audit/frames/f*.png'))
out=[]
for p in files:
    a = np.asarray(Image.open(p).convert('L'))
    m = a > 200
    lab, n = ndimage.label(m)
    comps=[]
    for sl in ndimage.find_objects(lab):
        y0,y1 = sl[0].start, sl[0].stop; x0,x1 = sl[1].start, sl[1].stop
        h,w = y1-y0, x1-x0
        if 20<=h<=45 and 8<=w<=25:      # cursor-cell shaped
            fill = m[sl].mean()
            if fill > 0.7: comps.append((int(y0),int(x0),int(h),int(w)))
    out.append(comps)
json.dump(out, open('/tmp/pi-audit/comps.json','w'))
multi=[(i+1,c) for i,c in enumerate(out) if len(c)>1]
print('frames:',len(out),'frames with >1 cursor-shaped block:',len(multi))
for i,c in multi[:30]: print(' ',i,c)
print('--- position sequence (first block) ---')
prev=None
for i,c in enumerate(out):
    cur = c[0] if c else None
    if cur!=prev: print(f'{i+1:4d}', cur)
    prev=cur
