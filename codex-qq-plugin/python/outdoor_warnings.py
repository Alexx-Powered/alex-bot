"""Select official red bulletins applicable to one forecast location and day."""
import re
from collections import defaultdict
from datetime import datetime, timedelta


def effective_time(alert, published):
    value = str(alert.get('effective', '')).replace('/', '-')
    try:
        stamp = datetime.fromisoformat(value)
        return stamp if stamp.tzinfo else stamp.replace(tzinfo=published.tzinfo)
    except ValueError:
        return published


def covers_place(alert, area):
    code, target = alert['code'], area['code']
    if code == target:
        return True
    if code not in {target[:2]+'0000', target[:4]+'00'}:
        return False
    body = alert['description']
    name = area['name'].split('·')[-1]
    return name in body or bool(re.search(r'全(?:省|市|区|自治区)(?:范围|各地|普遍|将|有|启动|解除|发布)|全域', body)) or (
        alert.get('sourceKey') in {'beijing_air', 'tianjin_air'} and '部分区' not in body)


def forecast_end(alert, published):
    text=alert['description']
    absolute=re.search(r'(?:持续至|有效期至|至|到)\s*(?:(\d{4})年)?(?:(\d{1,2})月)?(\d{1,2})日\s*(\d{1,2})[时点](?:(\d{1,2})分)?',text)
    if absolute:
        year,month,day,hour,minute=absolute.groups()
        month=int(month or published.month)
        year=int(year or (published.year+(published.month==12 and month==1)))
        try:
            return datetime(year,month,int(day),tzinfo=published.tzinfo)+timedelta(hours=int(hour),minutes=int(minute or 0))
        except ValueError:
            pass
    duration=re.search(r'(?:未来|预计今后)\s*(\d{1,3})(?:\s*[至到～~—-]\s*(\d{1,3}))?\s*(?:个)?小时',text)
    if duration:
        return published+timedelta(hours=int(duration[2] or duration[1]))
    return None


def report_red_hazards(alerts, area, date, now):
    midnight = datetime.fromisoformat(date).replace(tzinfo=now.tzinfo)
    tomorrow = midnight + timedelta(days=1)
    if not now.date() <= midnight.date() <= now.date()+timedelta(days=1):
        return []
    begin = max(now, midnight)
    series = defaultdict(list)
    for alert in alerts:
        published = datetime.fromisoformat(alert['publishedAt'])
        if published > now or alert['code'] not in {area['code'], area['code'][:2]+'0000', area['code'][:4]+'00'}:
            continue
        start = effective_time(alert, published)
        series[(alert['series'],alert['hazard'])].append((start, published, alert))
    hazards = set()
    for events in series.values():
        # A later bulletin replaces this issuer's earlier level at its effective time.
        events.sort(key=lambda event:(event[1],event[2]['id']),reverse=True)
        next_change = None
        for start, published, alert in events:
            end = next_change
            next_change = min(start,next_change) if next_change else start
            if alert['color'] != '红色' or not covers_place(alert, area):
                continue
            if alert.get('cancelled'):
                # An explicit future lifting of a red warning confirms the old
                # level only until that instant. Untimed cancellations never qualify.
                end, start = min(start,end) if end else start, published
            else:
                until=forecast_end(alert,published)
                if until:
                    end = min(end,until) if end else until
                # Today's bulletin without an explicit future validity window
                # is not evidence that tomorrow's forecast day is covered.
                if midnight.date() > now.date() and start < midnight and end is None:
                    continue
            if max(start,begin) < min(end or tomorrow,tomorrow):
                name=re.sub(r'\s+', '', alert['hazard'])
                hazards.add(name if re.fullmatch(r'[\u3400-\u9fffA-Za-z0-9（）()·、-]{1,40}',name) else '气象灾害')
    return sorted(hazards)
