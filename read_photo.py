#!/usr/bin/env python3
"""Overlay QR Shares - MIT (c) 2026 ipusiron.

Read an OQS v1 stack from PNG and four registration-mark centers. Standard library
only. This exports a QR image; it neither decodes nor verifies its secret text.
"""
import argparse
import math
from pathlib import Path
import struct
import sys
import zlib

PNG_SIGNATURE = b'\x89PNG\r\n\x1a\n'
MAX_FILE = 64 * 1024 * 1024
MAX_PIXELS = 24_000_000
IDS = ('2-2', '2-3', '2-4', '2-5', '3-3', '4-4', '5-5')
MSIZES = (2.032, 2.54)
ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
ALIGN = {3: (6, 22), 4: (6, 26), 5: (6, 30), 6: (6, 34), 7: (6, 22, 38)}


def wipe(values):
    """Best-effort clearing of mutable work arrays; Python cannot erase all copies."""
    if isinstance(values, bytearray):
        values[:] = bytes(len(values))
    else:
        for i in range(len(values)):
            values[i] = 0


def paeth(a, b, c):
    p = a + b - c
    da, db, dc = abs(p - a), abs(p - b), abs(p - c)
    return a if da <= db and da <= dc else b if db <= dc else c


def load_png(path):
    """Accept 8-bit non-interlaced gray/RGB/gray-alpha/RGBA; composite alpha on white."""
    with Path(path).open('rb') as stream:
        data = stream.read(MAX_FILE + 1)
    if len(data) > MAX_FILE:
        raise ValueError('PNG file exceeds 64 MiB')
    if not data.startswith(PNG_SIGNATURE):
        raise ValueError('PNG required; save JPEG or other images as PNG first')
    position, width, height, channels = 8, 0, 0, 0
    packed, raw, gray, previous = bytearray(), bytearray(), bytearray(), bytearray()
    ended, had_idat, idat_closed = False, False, False
    try:
        while position < len(data):
            if len(data) - position < 12:
                raise ValueError('truncated PNG chunk')
            size = struct.unpack_from('>I', data, position)[0]
            kind = data[position + 4:position + 8]
            stop = position + 12 + size
            if size > MAX_FILE or stop > len(data):
                raise ValueError('PNG chunk bounds')
            if any(not (65 <= ch <= 90 or 97 <= ch <= 122) for ch in kind) or kind[2] & 32:
                raise ValueError('invalid PNG chunk type')
            body = data[position + 8:position + 8 + size]
            crc = struct.unpack_from('>I', data, position + 8 + size)[0]
            if zlib.crc32(kind + body) & 0xffffffff != crc:
                raise ValueError('PNG chunk CRC mismatch')
            if not width and kind != b'IHDR':
                raise ValueError('PNG must start with IHDR')
            if had_idat and kind != b'IDAT':
                idat_closed = True
            if kind == b'IHDR':
                if width or size != 13:
                    raise ValueError('invalid or duplicate IHDR')
                width, height, depth, color, compression, filtering, interlace = struct.unpack('>IIBBBBB', body)
                channels = {0: 1, 2: 3, 4: 2, 6: 4}.get(color, 0)
                if not width or not height or width > 16384 or height > 16384 or width * height > MAX_PIXELS:
                    raise ValueError('PNG dimensions exceed limits')
                if depth != 8 or not channels or compression or filtering or interlace:
                    raise ValueError('use an 8-bit non-interlaced gray, RGB, gray-alpha or RGBA PNG')
            elif kind == b'IDAT':
                if idat_closed:
                    raise ValueError('nonconsecutive IDAT chunks')
                had_idat = True
                packed.extend(body)
            elif kind == b'IEND':
                if size or not had_idat or stop != len(data):
                    raise ValueError('invalid IEND or trailing PNG data')
                ended = True
                break
            elif kind == b'tRNS':
                raise ValueError('tRNS transparency is unsupported; save as RGBA PNG')
            elif kind == b'PLTE':
                if had_idat or color in (0, 4) or not size or size % 3 or size > 768:
                    raise ValueError('invalid PNG palette')
            elif not kind[0] & 32:
                raise ValueError('unsupported critical PNG chunk')
            position = stop
        if not ended:
            raise ValueError('missing PNG IEND')
        stride = width * channels
        expected = (stride + 1) * height
        inflater = zlib.decompressobj()
        raw = bytearray(inflater.decompress(packed, expected + 1))
        if len(raw) != expected or not inflater.eof or inflater.unused_data or inflater.unconsumed_tail:
            raise ValueError('PNG decompressed size or zlib stream mismatch')
        gray, previous = bytearray(width * height), bytearray(stride)
        for y in range(height):
            start = y * (stride + 1)
            filt = raw[start]
            if filt > 4:
                raise ValueError('invalid PNG filter')
            row = raw[start + 1:start + stride + 1]
            try:
                if filt:
                    for i in range(stride):
                        left = row[i - channels] if i >= channels else 0
                        above = previous[i]
                        upper_left = previous[i - channels] if i >= channels else 0
                        predict = (left, above, (left + above) // 2, paeth(left, above, upper_left))[filt - 1]
                        row[i] = (row[i] + predict) & 255
                if channels == 1:
                    gray[y * width:(y + 1) * width] = row
                else:
                    for x in range(width):
                        offset = x * channels
                        if color in (0, 4):
                            luminance = row[offset]
                        else:
                            luminance = (299 * row[offset] + 587 * row[offset + 1] + 114 * row[offset + 2] + 500) // 1000
                        alpha = row[offset + channels - 1] if color in (4, 6) else 255
                        gray[y * width + x] = (luminance * alpha + 255 * (255 - alpha) + 127) // 255
                previous[:] = row
            finally:
                wipe(row)
        result, gray = gray, bytearray()
        return result, width, height
    finally:
        for buffer in (packed, raw, gray, previous):
            wipe(buffer)


def solve(matrix, rhs):
    work = [list(row) + [value] for row, value in zip(matrix, rhs)]
    n = len(rhs)
    try:
        for col in range(n):
            pivot = max(range(col, n), key=lambda row: abs(work[row][col]))
            if abs(work[pivot][col]) < 1e-10:
                raise ValueError('singular geometry or illumination fit')
            work[col], work[pivot] = work[pivot], work[col]
            divisor = work[col][col]
            for j in range(col, n + 1):
                work[col][j] /= divisor
            for row in range(n):
                if row != col:
                    factor = work[row][col]
                    for j in range(col, n + 1):
                        work[row][j] -= factor * work[col][j]
        return [row[n] for row in work]
    finally:
        for row in work:
            wipe(row)


def homography(source, destination):
    matrix, rhs = [], []
    for (x, y), (u, v) in zip(source, destination):
        matrix.extend(([x, y, 1, 0, 0, 0, -u * x, -u * y], [0, 0, 0, x, y, 1, -v * x, -v * y]))
        rhs.extend((u, v))
    return solve(matrix, rhs) + [1]


def sampler(gray, width, height, matrix):
    def sample(x, y):
        denominator = matrix[6] * x + matrix[7] * y + matrix[8]
        if abs(denominator) < 1e-10:
            raise ValueError('invalid projective sample')
        px = math.floor((matrix[0] * x + matrix[1] * y + matrix[2]) / denominator)
        py = math.floor((matrix[3] * x + matrix[4] * y + matrix[5]) / denominator)
        if px < 1 or py < 1 or px >= width - 1 or py >= height - 1:
            raise ValueError('sample outside image; include the complete marks, QR and strips')
        return sum(gray[(py + dy) * width + px + dx] for dy in (-1, 0, 1) for dx in (-1, 0, 1)) / 9
    return sample


def otsu(values):
    histogram = [0] * 256
    for value in values:
        histogram[max(0, min(255, math.floor(value * 255 + 0.5)))] += 1
    total, partial, weight, best, threshold = sum(i * n for i, n in enumerate(histogram)), 0, 0, -1, 127
    for i, count in enumerate(histogram):
        weight += count
        partial += i * count
        if not weight or weight == len(values):
            continue
        remaining = len(values) - weight
        difference = partial / weight - (total - partial) / remaining
        variance = weight * remaining * difference * difference
        if variance > best:
            best, threshold = variance, i
    return (threshold + 0.5) / 255


def parse_band(bits):
    value = 0
    for bit in bits:
        value = value * 2 + bit
    raw = value.to_bytes(6, 'big')
    crc = 0
    for byte in raw[:5]:
        crc ^= byte
        for _ in range(8):
            crc = ((crc << 1) ^ (0x07 if crc & 0x80 else 0)) & 255
    if crc != raw[5]:
        raise ValueError('band CRC mismatch')
    fmt, code, version = value >> 44, (value >> 40) & 15, ((value >> 36) & 15) + 3
    ecl, size = ('Q' if value >> 35 & 1 else 'M'), (value >> 32) & 7
    if fmt != 1 or not 1 <= code <= 7 or not 3 <= version <= 7 or size > 1 or value >> 8 & 15:
        raise ValueError('invalid OQS v1 band fields')
    if size == 1 and version > 4:
        raise ValueError('OQS band layout does not fit A4')
    set_id = ''.join(ALPHA[(value >> shift) & 31] for shift in (27, 22, 17, 12))
    return {'id': IDS[code - 1], 'version': version, 'ecl': ecl, 'msizeCode': size, 'setId': set_id}


def read_band(at, version, m):
    q = 25 + 4 * version
    values = []
    try:
        for i in range(48):
            row, col = divmod(i, 3)
            y = (4 + row + 0.5) * m
            white, value = at((q + 3.5) * m, y), at((q + 4 + col + 0.5) * m, y)
            values.append(max(0, min(1, (white - value) / max(1, white))))
        threshold = otsu(values)
        return parse_band([int(value > threshold) for value in values])
    finally:
        wipe(values)


def fixed_patterns(version):
    """Public fixed values only: finder/separator, timing, alignment, dark, version BCH."""
    n = 17 + 4 * version
    mask, bits = bytearray(n * n), bytearray(n * n)
    def put(row, col, bit):
        if 0 <= row < n and 0 <= col < n:
            mask[row * n + col], bits[row * n + col] = 1, int(bit)
    for r0, c0 in ((0, 0), (0, n - 7), (n - 7, 0)):
        for row in range(-1, 8):
            for col in range(-1, 8):
                black = (0 <= row <= 6 and col in (0, 6)) or (0 <= col <= 6 and row in (0, 6))
                put(r0 + row, c0 + col, black or (2 <= row <= 4 and 2 <= col <= 4))
    for i in range(8, n - 8):
        put(6, i, i % 2 == 0)
        put(i, 6, i % 2 == 0)
    centers = ALIGN[version]
    for cy in centers:
        for cx in centers:
            if (cy, cx) in ((6, 6), (6, centers[-1]), (centers[-1], 6)):
                continue
            for row in range(-2, 3):
                for col in range(-2, 3):
                    put(cy + row, cx + col, abs(row) == 2 or abs(col) == 2 or row == col == 0)
    put(n - 8, 8, 1)
    if version >= 7:
        rem = version << 12
        while rem.bit_length() >= 13:
            rem ^= 0x1f25 << (rem.bit_length() - 13)
        info = (version << 12) | rem
        for i in range(18):
            put(i // 3, i % 3 + n - 11, info >> i & 1)
            put(i % 3 + n - 11, i // 3, info >> i & 1)
    return mask, bits


def features(x, y):
    return (1, x, y, x * x, x * y, y * y)


def fit_surface(points):
    if len(points) < 6:
        raise ValueError('insufficient public illumination samples')
    matrix, rhs = [[0.0] * 6 for _ in range(6)], [0.0] * 6
    for x, y, value in points:
        f = features(x, y)
        for row in range(6):
            rhs[row] += f[row] * value
            for col in range(6):
                matrix[row][col] += f[row] * f[col]
    return solve(matrix, rhs)


def reconstruct(at, metadata, offset=0):
    version, scheme, m = metadata['version'], metadata['id'], MSIZES[metadata['msizeCode']]
    n, q = 17 + 4 * version, 25 + 4 * version
    rows, cols = (4, 4) if scheme == '5-5' else (2, 4) if scheme == '4-4' else (2, 2)
    mask, fixed = fixed_patterns(version)
    raw, samples, dark, data = [], [], [], []
    whites, blacks, white_fit, black_fit, calibration = [], [], [], [], []
    try:
        for row in range(n):
            for col in range(n):
                cells = [at((4 + col + (c + 0.5) / cols) * m, (4 + row + (r + 0.5) / rows) * m)
                         for r in range(rows) for c in range(cols)]
                value = sum(cells) / (rows * cols)
                samples.append(cells)
                raw.append(value)
                if mask[row * n + col]:
                    group = blacks if fixed[row * n + col] else whites
                    group.append(((col + 4.5) / q - 0.5, (row + 4.5) / q - 0.5, value))
        for i in range(1, q, 2):
            for col, row in ((i, 1), (i, q - 2), (1, i), (q - 2, i)):
                whites.append(((col + 0.5) / q - 0.5, (row + 0.5) / q - 0.5, at((col + 0.5) * m, (row + 0.5) * m)))
        white_fit, black_fit = fit_surface(whites), fit_surface(blacks)
        def darkness(value, x, y):
            f = features(x, y)
            white = sum(a * b for a, b in zip(white_fit, f))
            black = sum(a * b for a, b in zip(black_fit, f))
            if white - black < 8:
                raise ValueError('insufficient lighting contrast')
            return max(0, min(1, (white - value) / (white - black)))
        for row in range(n):
            for col in range(n):
                index, total = row * n + col, 0
                for r in range(rows):
                    for c in range(cols):
                        x, y = (4 + col + (c + 0.5) / cols) / q - 0.5, (4 + row + (r + 0.5) / rows) / q - 0.5
                        total += darkness(samples[index][r * cols + c], x, y)
                dark.append(total / (rows * cols))
                if not mask[index]:
                    data.append(dark[-1])
        mismatches = sum((dark[i] > 0.5) != bool(fixed[i]) for i in range(n * n) if mask[i])
        if mismatches > sum(mask) * 0.1:
            raise ValueError('public QR fixed patterns do not match')
        for i in range(16):
            row, col = divmod(i, 2)
            total = 0
            for r in range(rows):
                for c in range(cols):
                    x, y = q + 1 + col + (c + 0.5) / cols, 4 + row + (r + 0.5) / rows
                    total += darkness(at(x * m, y * m), x / q - 0.5, y / q - 0.5)
            calibration.append(total / (rows * cols))
        white = sum(v for i, v in enumerate(calibration) if (i // 2 + i % 2) % 2 == 0) / 8
        black = sum(v for i, v in enumerate(calibration) if (i // 2 + i % 2) % 2 == 1) / 8
        if black - white <= 0.001:
            raise ValueError('calibration does not separate white and black')
        threshold = otsu(data) + offset * (black - white)
        modules = bytearray(int(value > (0.5 if mask[i] else threshold)) for i, value in enumerate(dark))
        return modules, n, {'threshold': threshold, 'calibrationGap': black - white}
    finally:
        for buffer in (mask, fixed, raw, dark, data, white_fit, black_fit, calibration):
            wipe(buffer)
        for cells in samples:
            wipe(cells)
        whites.clear()
        blacks.clear()


def parse_corners(value):
    try:
        points = [tuple(float(part) for part in item.split(',')) for item in value.split()]
    except ValueError as exc:
        raise argparse.ArgumentTypeError('corners must be four x,y pixel coordinates') from exc
    if len(points) != 4 or any(len(point) != 2 or not all(math.isfinite(v) for v in point) for point in points):
        raise argparse.ArgumentTypeError('corners must be four finite x,y pixel coordinates')
    signs = []
    for i, point in enumerate(points):
        nxt, last = points[(i + 1) % 4], points[(i + 2) % 4]
        signs.append((nxt[0] - point[0]) * (last[1] - nxt[1]) - (nxt[1] - point[1]) * (last[0] - nxt[0]))
    if not (all(value > 1 for value in signs) or all(value < -1 for value in signs)):
        raise argparse.ArgumentTypeError('corners must form a convex quadrilateral in perimeter order')
    return points


def recover(gray, width, height, corners, offset=0):
    if any(not 1 <= x < width - 1 or not 1 <= y < height - 1 for x, y in corners):
        raise ValueError('mark centers must be inside the image')
    candidates, last_error = [], 'no valid OQS band; check the four mark centers and image orientation'
    for rotation in range(4):
        points = corners[rotation:] + corners[:rotation]
        for oriented in (points, [points[0], points[3], points[2], points[1]]):
            for size, m in enumerate(MSIZES):
                for version in range(3, 8 if size == 0 else 5):
                    q = 25 + 4 * version
                    w, h = (q + 7) * m, q * m
                    source = [(-3.5, -3.5), (w + 3.5, -3.5), (w + 3.5, h + 3.5), (-3.5, h + 3.5)]
                    matrix = homography(source, oriented)
                    try:
                        at = sampler(gray, width, height, matrix)
                        metadata = read_band(at, version, m)
                        if metadata['version'] != version or metadata['msizeCode'] != size:
                            continue
                        candidates.append((metadata, matrix[:]))
                    except ValueError:
                        pass
                    finally:
                        wipe(matrix)
    try:
        for metadata, matrix in candidates:
            try:
                modules, n, diag = reconstruct(sampler(gray, width, height, matrix), metadata, offset)
                return modules, n, metadata, diag
            except ValueError as exc:
                last_error = str(exc)
        raise ValueError(last_error)
    finally:
        for _, matrix in candidates:
            wipe(matrix)


def pbm_bytes(modules, n, scale):
    side = (n + 8) * scale
    stride = (side + 7) // 8
    output = bytearray(stride * side)
    for row in range(n):
        for col in range(n):
            if modules[row * n + col]:
                for y in range((row + 4) * scale, (row + 5) * scale):
                    for x in range((col + 4) * scale, (col + 5) * scale):
                        output[y * stride + x // 8] |= 0x80 >> (x % 8)
    return bytearray(('P4\n%d %d\n' % (side, side)).encode('ascii')) + output


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('image', type=Path, help='PNG photo of the complete overlaid sample')
    parser.add_argument('--corners', required=True, type=parse_corners,
                        help='"x,y x,y x,y x,y": mark centers in image TL, TR, BR, BL order')
    parser.add_argument('--output', required=True, type=Path, help='new PBM output file; existing files are never overwritten')
    parser.add_argument('--scale', type=int, choices=range(1, 33), default=8, metavar='1..32', help='pixels per output module (default: 8)')
    parser.add_argument('--threshold-offset', type=float, choices=(-0.2, -0.1, 0, 0.1, 0.2), default=0,
                        help='optional Otsu offset in fractions of measured calibration gap (default: 0)')
    args = parser.parse_args(argv)
    gray, modules, output = bytearray(), bytearray(), bytearray()
    try:
        if args.output.exists():
            raise ValueError('output already exists; choose a new filename')
        gray, width, height = load_png(args.image)
        modules, n, metadata, _ = recover(gray, width, height, args.corners, args.threshold_offset)
        output = pbm_bytes(modules, n, args.scale)
        with args.output.open('xb') as stream:
            stream.write(output)
        print('PBM written: scheme %s, QR version %d/%s. Read it with a QR reader; secret text has not been verified.'
              % (metadata['id'], metadata['version'], metadata['ecl']))
        return 0
    except (OSError, ValueError, zlib.error) as exc:
        print('read_photo: ' + str(exc), file=sys.stderr)
        return 1
    finally:
        for buffer in (gray, modules, output):
            wipe(buffer)


if __name__ == '__main__':
    sys.exit(main())
