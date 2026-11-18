from pathlib import Path
import json
from PIL import Image
import numpy as np

root = Path(__file__).resolve().parents[1]
image = np.array(Image.open(root / 'artifacts/product-reader-original.png').convert('RGB'))
left = image[405:575, 620:800]
right = image[405:575, 1186:1366]
# GPU placement can differ by a device pixel. Compare each possible integer alignment.
results = []
for dy in (-1, 0, 1):
    for dx in (-1, 0, 1):
        a = left[1:-1, 1:-1].astype(int)
        b = right[1+dy:right.shape[0]-1+dy, 1+dx:right.shape[1]-1+dx].astype(int)
        difference = np.max(np.abs(a-b), axis=2)
        results.append({'offset': [dx, dy], 'equal_pixels': int((difference == 0).sum()), 'total_pixels': int(difference.size), 'within_2_fraction': float((difference <= 2).mean())})
best = max(results, key=lambda value: value['within_2_fraction'])
assert best['within_2_fraction'] > .98, best
proof = {'input': 'product-reader-original.png', 'test': 'Actual native paired chart artwork comparison; excludes translated caption and heading', 'best_alignment': best, 'translation_quality': 'Not evaluated: deterministic local test provider only'}
(root / 'artifacts/native-art-verification.json').write_text(json.dumps(proof, indent=2), encoding='utf-8')
print(json.dumps(proof, indent=2))
