"""A bounded keep-alive pool shared by the downloads for one weather video."""
from contextlib import contextmanager
from functools import partial
from threading import Event
from urllib.parse import urlsplit
import ssl

import httpx

from video_trace import sample
from weather_video_codec import VideoFailure

HOSTS = {'www.jma.go.jp', 'api.open-meteo.com', 'air-quality-api.open-meteo.com', 'geo.weather.gc.ca'}
MAX_CONNECTIONS = 8


@contextmanager
def pooled_downloads():
    limits = httpx.Limits(max_connections=MAX_CONNECTIONS, max_keepalive_connections=MAX_CONNECTIONS)
    with httpx.Client(verify=ssl.create_default_context(), timeout=10, limits=limits, follow_redirects=False,
                      headers={'User-Agent':'AlexQQBot-WeatherVideo/1.0', 'Accept-Encoding':'identity'}) as client:
        yield partial(_read, client, {host: Event() for host in HOSTS})


def _read(client, throttled, url, limit=2_000_000):
    parts = urlsplit(url)
    if parts.scheme != 'https' or parts.netloc not in HOSTS:
        raise VideoFailure('VIDEO_SOURCE_INVALID')
    if throttled[parts.netloc].is_set():
        raise VideoFailure('VIDEO_SOURCE_UNAVAILABLE')
    try:
        with sample('video_download_slowest'), client.stream('GET', url) as response:
            if response.is_redirect:
                raise VideoFailure('VIDEO_SOURCE_INVALID')
            if response.status_code == 429:
                throttled[parts.netloc].set()
            if response.status_code != 200:
                raise VideoFailure('VIDEO_SOURCE_UNAVAILABLE', transient=response.status_code in (408,500,502,503,504))
            if response.headers.get('content-encoding','identity').lower() != 'identity':
                raise VideoFailure('VIDEO_SOURCE_INVALID')
            size = response.headers.get('content-length')
            if size is not None and (not size.isdecimal() or int(size) > limit):
                raise VideoFailure('VIDEO_SOURCE_INVALID')
            data = bytearray()
            for block in response.iter_raw(65536):
                if len(data) + len(block) > limit:
                    raise VideoFailure('VIDEO_SOURCE_INVALID')
                data.extend(block)
            return bytes(data)
    except httpx.RequestError as error:
        raise VideoFailure('VIDEO_SOURCE_UNAVAILABLE', transient=isinstance(error, httpx.TransportError)) from None


def request(url, limit=2_000_000):
    with pooled_downloads() as fetch:
        return fetch(url, limit)
