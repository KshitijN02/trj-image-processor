//! Reads lines of "<id>\t<source.png>\t<distorted.png>" on stdin and prints
//! "<id>\t<score>" using the reference `ssimulacra2` crate (v0.5.1).
use std::io::{self, BufRead, Write};

use ssimulacra2::{compute_frame_ssimulacra2, ColorPrimaries, Rgb, TransferCharacteristic};

fn load(path: &str) -> Rgb {
    let img = image::open(path).unwrap_or_else(|e| panic!("cannot open {path}: {e}"));
    let data = img
        .to_rgb32f()
        .chunks_exact(3)
        .map(|c| [c[0], c[1], c[2]])
        .collect::<Vec<_>>();
    Rgb::new(
        data,
        img.width() as usize,
        img.height() as usize,
        TransferCharacteristic::SRGB,
        ColorPrimaries::BT709,
    )
    .expect("valid image")
}

fn main() {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    for line in io::stdin().lock().lines() {
        let line = line.expect("stdin");
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() != 3 {
            continue;
        }
        let score = compute_frame_ssimulacra2(load(parts[1]), load(parts[2])).expect("score");
        writeln!(out, "{}\t{:.6}", parts[0], score).expect("stdout");
    }
}
