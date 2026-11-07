"""Operator scheduled job: bounded climate backfill from a trusted place catalog."""
from pathlib import Path
import argparse
import json
import signal
import sys
import threading

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'python'))
from climate_history import ClimateHistory,ClimateLocation,run_refresh_loop,latest_available_year


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database',type=Path,required=True)
    parser.add_argument('--catalog',type=Path,required=True)
    parser.add_argument('--place-id',required=True)
    parser.add_argument('--start-year',type=int,default=1991)
    parser.add_argument('--end-year',default='2020',help='year or latest (recomputed each watch tick)')
    parser.add_argument('--max-years',type=int,default=1)
    parser.add_argument('--watch',action='store_true')
    parser.add_argument('--interval-seconds',type=int,default=3600)
    parser.add_argument('--max-runs',type=int,default=24,help='watch iterations; 0 explicitly runs until stopped')
    parser.add_argument('--retry-failed',action='store_true',help='explicitly re-enable parked years once before this run')
    args=parser.parse_args()
    if args.catalog.is_symlink() or args.catalog.stat().st_size>100000:raise ValueError('CLIMATE_INVALID_CATALOG')
    payload=json.loads(args.catalog.read_text(encoding='utf-8-sig'))
    if not isinstance(payload,dict) or payload.get('schema_version')!='climate.locations.v1':raise ValueError('CLIMATE_INVALID_CATALOG')
    selected=[row for row in payload.get('locations',[]) if row.get('place_id')==args.place_id]
    if len(selected)!=1 or not selected[0].get('source'):raise ValueError('CLIMATE_UNKNOWN_PLACE')
    row=selected[0]
    location=ClimateLocation(row['place_id'],row['latitude'],row['longitude'],row.get('timezone','Asia/Shanghai'))
    service=ClimateHistory(args.database)
    end_year='latest' if args.end_year=='latest' else int(args.end_year)
    if args.retry_failed:
        service.retry_failed(location,args.start_year,latest_available_year(service.clock()) if end_year=='latest' else end_year)
    if args.watch:
        stop=threading.Event()
        signal.signal(signal.SIGINT,lambda *unused:stop.set())
        signal.signal(signal.SIGTERM,lambda *unused:stop.set())
        run_refresh_loop(service,location,start_year=args.start_year,end_year=end_year,
            max_years=args.max_years,interval_seconds=args.interval_seconds,max_runs=args.max_runs,
            stop_event=stop,on_result=lambda row:print(json.dumps(row,ensure_ascii=False),flush=True))
        return 0
    result=service.refresh(location,args.start_year,
        latest_available_year(service.clock()) if end_year=='latest' else end_year,args.max_years)
    print(json.dumps(result,ensure_ascii=False))
    return 1 if result['status'] in ('failed','partial','needs_attention') else 0


if __name__=='__main__':sys.exit(main())
