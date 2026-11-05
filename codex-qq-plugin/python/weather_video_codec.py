"""Encode one bounded, lossless frame spool after the rendering process exits."""
import os
import re
import shutil
import subprocess
import struct
import time
import uuid
from pathlib import Path
from contextlib import contextmanager

OUTPUT_SIZE = 1080
FPS = 12
# The worst-case 145-frame RGB TGA spool fits within 512 MiB, including RLE headers.
MAX_SPOOL = 512 * 1024 * 1024
DISK_RESERVE = 128 * 1024 * 1024


class VideoFailure(Exception):
    def __init__(self, code, *, transient=False):
        super().__init__(code)
        self.code = code
        self.transient = transient


def output_directory(private):
    directory = Path(private) / 'weather-video'
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    for path in directory.glob('*.mp4'):
        try:
            if time.time()-path.stat().st_mtime > 600:
                path.unlink(missing_ok=True)
        except FileNotFoundError:
            pass
    for job in directory.glob('job-*'):
        if re.fullmatch(r'job-[a-f0-9]{32}',job.name) and not job.is_symlink() and job.is_dir() and time.time()-job.stat().st_mtime>600:
            clean_frames(job,directory)
    return directory


def clean_frames(job, directory):
    if job.is_symlink() or job.resolve().parent!=directory.resolve():return
    files=list(job.iterdir())
    if not all(re.fullmatch(r'frame-\d{3}\.(?:png|tga)',p.name) and p.is_file() for p in files):return
    for file in files:file.unlink(missing_ok=True)
    job.rmdir()


@contextmanager
def frame_folder(directory):
    job=directory/('job-'+uuid.uuid4().hex)
    job.mkdir(mode=0o700)
    try:yield job
    finally:clean_frames(job,directory)


class FrameFiles:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.count = 0
        self.bytes = 0
        self.extension = None

    def append(self, image):
        if self.count>=145 or image.mode!='RGB' or image.size!=(OUTPUT_SIZE,OUTPUT_SIZE):raise VideoFailure('VIDEO_ENCODING_FAILED')
        free = shutil.disk_usage(self.directory).free
        if free < DISK_RESERVE + 4*1024*1024:
            raise VideoFailure('VIDEO_ENCODING_FAILED')
        if self.extension is None:
            self.extension = 'tga' if free >= DISK_RESERVE + MAX_SPOOL else 'png'
        target=self.directory / f'frame-{self.count:03d}.{self.extension}'
        if self.extension == 'tga':
            image.save(target,format='TGA',compression='tga_rle')
        else:
            image.save(target,format='PNG',compress_level=1)
        self.bytes+=target.stat().st_size
        if self.bytes>MAX_SPOOL:raise VideoFailure('VIDEO_ENCODING_FAILED')
        self.count+=1


def sample_count(path):
    """Read the single H.264 track's MP4 sample table without loading its media."""
    start,end=0,path.stat().st_size
    with path.open('rb') as file:
        for tag in (b'moov',b'trak',b'mdia',b'minf',b'stbl',b'stsz'):
            cursor=start
            while cursor+8<=end:
                file.seek(cursor);length,kind=struct.unpack('>I4s',file.read(8))
                if length<8 or cursor+length>end:raise VideoFailure('VIDEO_ENCODING_FAILED')
                if kind==tag:
                    start,end=cursor+8,cursor+length
                    break
                cursor+=length
            else:raise VideoFailure('VIDEO_ENCODING_FAILED')
        if end-start<12:raise VideoFailure('VIDEO_ENCODING_FAILED')
        file.seek(start+8)
        return struct.unpack('>I',file.read(4))[0]


def finish_video(frame_directory, metadata, directory, deadline):
    import imageio_ffmpeg
    count=metadata['frames']
    files=sorted(frame_directory.glob('frame-*'))
    if not isinstance(count,int) or not 2<=count<=145 or len(files)!=count:raise VideoFailure('VIDEO_ENCODING_FAILED')
    extension=files[0].suffix
    if extension not in ('.tga','.png'):raise VideoFailure('VIDEO_ENCODING_FAILED')
    total=0
    for i,file in enumerate(files):
        if file.name!=f'frame-{i:03d}{extension}' or file.is_symlink() or not file.is_file():raise VideoFailure('VIDEO_ENCODING_FAILED')
        total+=file.stat().st_size
    if not 1000<total<=MAX_SPOOL:raise VideoFailure('VIDEO_ENCODING_FAILED')
    identifier=uuid.uuid4().hex; target=directory/(identifier+'.mp4')
    # FFmpeg decodes TGA as BGR24. Give the YUV conversion exactly the RGB24
    # input it previously received from PNG to preserve the encoded colours.
    rgb_filter=['-vf','format=rgb24'] if extension=='.tga' else []
    command=[imageio_ffmpeg.get_ffmpeg_exe(),'-hide_banner','-loglevel','error','-y','-f','image2','-pattern_type','sequence',
             '-framerate',str(FPS),'-start_number','0','-threads','1','-thread_queue_size','1','-i',str(frame_directory/('frame-%03d'+extension)),
             '-frames:v',str(count),'-an','-fps_mode','passthrough',*rgb_filter,'-c:v','libx264','-preset','superfast','-tune','zerolatency',
             '-x264-params','threads=1:ref=1:bframes=0:rc-lookahead=0:sync-lookahead=0','-crf','19','-threads','1',
             '-filter_threads','1','-pix_fmt','yuv420p','-movflags','+faststart','-maxrate','2000k','-bufsize','1500k',str(target)]
    complete=False
    try:
        proc=subprocess.run(command,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                            timeout=max(.1,deadline-time.monotonic()),creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
        if proc.returncode or not 1000<target.stat().st_size<=4*1024*1024 or sample_count(target)!=count:
            raise VideoFailure('VIDEO_ENCODING_FAILED')
        complete=True
        return {**metadata,'artifact_id':identifier,'bytes':target.stat().st_size}
    except subprocess.TimeoutExpired as error:
        raise VideoFailure('VIDEO_TIMEOUT') from error
    finally:
        if not complete:target.unlink(missing_ok=True)
