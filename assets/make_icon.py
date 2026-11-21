"""Generate the 180x180 storefront icon for the awesome-dsh-plugin registry.

Registry rules: a storefront tile is ONE GitHub-hosted raster (png/jpg/webp),
drawn at ~180x180, square, self-contained. SVG and third-party image hosts are
rejected. The subject mirrors the plugin's sidebar glyph: stacked sheets (a
catalogue) plus a timeline rail with the three states.
"""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), "icon-180.png")
os.makedirs(os.path.dirname(OUT), exist_ok=True)

S = 180
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# Soft rounded backdrop tile so the icon reads on any storefront background.
d.rounded_rectangle((10, 10, 170, 170), radius=34, fill=(238, 243, 248, 255),
                    outline=(198, 212, 226, 255), width=3)

# Back sheet (offset stack).
d.rounded_rectangle((56, 36, 126, 128), radius=8, fill=(174, 193, 212, 255),
                    outline=(120, 145, 170, 255), width=3)
# Fold of the back sheet.
d.polygon([(104, 36), (126, 58), (104, 58)], fill=(150, 172, 194, 255))

# Front sheet.
d.rounded_rectangle((38, 56, 108, 148), radius=8, fill=(252, 253, 255, 255),
                    outline=(104, 132, 160, 255), width=3)
# Folded corner of the front sheet.
d.polygon([(86, 56), (108, 78), (86, 78)], fill=(205, 219, 233, 255))
d.line([(86, 56), (86, 78), (108, 78)], fill=(104, 132, 160, 255), width=3)
# Text lines.
for i, w in enumerate((44, 44, 30)):
    y = 94 + i * 13
    d.rounded_rectangle((50, y, 50 + w, y + 5), radius=2, fill=(154, 175, 196, 255))

# Timeline rail: kept / changed / deleted.
d.line([(146, 76), (146, 146)], fill=(63, 157, 107, 150), width=5)
for cy, color in ((84, (63, 157, 107, 255)),
                  (114, (215, 154, 36, 255)),
                  (144, (207, 79, 71, 255))):
    d.ellipse((138, cy - 8, 154, cy + 8), fill=color,
              outline=(255, 255, 255, 255), width=2)

img.save(OUT, "PNG", optimize=True)
print(f"wrote {OUT}  {os.path.getsize(OUT)} bytes  {img.size}")