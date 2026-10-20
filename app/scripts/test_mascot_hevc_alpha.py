"""Native HEVC alpha round-trip for the app clip encoder (macOS only)."""

import importlib.util
from pathlib import Path
import shutil
import subprocess
import sys

import numpy as np
from PIL import Image
import pytest

_spec = importlib.util.spec_from_file_location("app_clips", Path(__file__).with_name("mascot-app-clips.py"))
app_clips = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(app_clips)

pytestmark = pytest.mark.skipif(
    sys.platform != "darwin" or not shutil.which("ffmpeg") or not shutil.which("xcrun"),
    reason="Needs the macOS HEVC-alpha encoder and AVFoundation decoder",
)

DECODER = r'''
#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>
int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 3) return 2;
        AVURLAsset *asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:@(argv[1])] options:nil];
        AVAssetImageGenerator *generator = [[AVAssetImageGenerator alloc] initWithAsset:asset];
        generator.requestedTimeToleranceBefore = kCMTimeZero;
        generator.requestedTimeToleranceAfter = kCMTimeZero;
        dispatch_semaphore_t finished = dispatch_semaphore_create(0);
        __block int result = 0;
        [generator generateCGImageAsynchronouslyForTime:kCMTimeZero completionHandler:^(CGImageRef image, CMTime actualTime, NSError *error) {
            if (!image) {
                fprintf(stderr, "%s\n", error.description.UTF8String);
                result = 1;
            } else {
                CGImageDestinationRef destination = CGImageDestinationCreateWithURL((__bridge CFURLRef)[NSURL fileURLWithPath:@(argv[2])], CFSTR("public.png"), 1, NULL);
                if (!destination) result = 1;
                else {
                    CGImageDestinationAddImage(destination, image, NULL);
                    if (!CGImageDestinationFinalize(destination)) result = 1;
                    CFRelease(destination);
                }
            }
            dispatch_semaphore_signal(finished);
        }];
        if (dispatch_semaphore_wait(finished, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC))) {
            fprintf(stderr, "Frame generation timed out\n");
            [generator cancelAllCGImageGeneration];
            return 1;
        }
        return result;
    }
}
'''


def test_native_hevc_keeps_a_partial_edge_colour_instead_of_dividing_it_by_alpha(tmp_path, monkeypatch):
    source = np.zeros((128, 128, 4), np.uint8)
    source[16:112, 16:112] = (64, 40, 80, 128)
    source[48:80, 48:80] = (64, 40, 80, 255)
    frames = tmp_path / "frames"
    frames.mkdir()
    Image.fromarray(source, "RGBA").save(frames / "000.png")
    monkeypatch.setattr(app_clips, "OUT", tmp_path)
    app_clips.encode("sample", frames, 128, 0, 0)

    decoder_source = tmp_path / "decode.m"
    decoder_source.write_text(DECODER)
    decoder = tmp_path / "decode"
    subprocess.run([
        "xcrun", "clang", "-fobjc-arc", "-fno-modules", str(decoder_source),
        "-framework", "AVFoundation", "-framework", "Foundation", "-framework", "ImageIO",
        "-framework", "CoreMedia", "-framework", "CoreGraphics", "-o", str(decoder),
    ], check=True)
    decoded_path = tmp_path / "decoded.png"
    subprocess.run([str(decoder), str(tmp_path / "sample.mov"), str(decoded_path)], check=True)
    decoded = np.asarray(Image.open(decoded_path).convert("RGBA"))

    # Subsampled HEVC quantizes straight edge RGB. Check its visible
    # contribution on both grounds, rather than promising lossless colour.
    # Dividing RGB by alpha twice makes this 50% edge much brighter.
    for ground in [(17, 16, 21), (245, 244, 248)]:
        background = np.array(ground, np.float32)
        expected_alpha = source[32, 64, 3] / 255
        actual_alpha = decoded[32, 64, 3] / 255
        expected = source[32, 64, :3] * expected_alpha + background * (1 - expected_alpha)
        actual = decoded[32, 64, :3] * actual_alpha + background * (1 - actual_alpha)
        np.testing.assert_allclose(actual, expected, atol=8)
    assert abs(int(decoded[32, 64, 3]) - 128) <= 2
    np.testing.assert_allclose(decoded[64, 64, :3], source[64, 64, :3], atol=8)
    assert decoded[64, 64, 3] == 255
    assert decoded[0, 0, 3] == 0
