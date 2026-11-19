import unittest
from unittest.mock import patch
from langchain_core.messages import AIMessage
from campus_classrooms import envelope
import campus_planner as plan
from campus_recommendations import recommend, build_recommendation_tool, verified_explanation
import campus_worker
import agent_worker
from test_agent_worker import ScriptedModel, packet, call


def snapshot():
    data=envelope('2026-10-29','OK')
    data.update(ok=True,fetched_at='2026-10-29T09:00:00+08:00',buildings=['三号楼'])
    rooms=['105','106','107','117','119','120','123','125','126','127','201','202','203','209','214','215','204']
    data['rooms']=[dict(building='三号楼',room=room,free_periods=list(range(1,15)),busy_periods=[]) for room in rooms]
    return data


def set_busy(data,room,*periods):
    row=next(r for r in data['rooms'] if r['room']==room)
    row.update(free_periods=[p for p in range(1,15) if p not in periods],busy_periods=list(periods))


class PriorityTests(unittest.TestCase):
    def test_morning_evening_ignore_preceding_busy_and_small_is_tier_one(self):
        rooms={'105':'F'*14,'201':'F'*9+'B'+'F'*4}
        self.assertEqual(plan.recommendation_tier(dict(kind='full',room='105',start=1,end=5),rooms),1)
        self.assertEqual(plan.recommendation_tier(dict(kind='full',room='105',start=11,end=14),rooms),1)
        self.assertEqual(plan.recommendation_tier(dict(kind='full',room='201',start=11,end=14),rooms),2)
        self.assertEqual(plan.recommendation_tier(dict(kind='evening',room='105',start=12,end=14),rooms),1)

    def test_afternoon_size_precedes_fifth_period_bonus(self):
        rooms={'105':'F'*14,'106':'F'*4+'B'+'F'*9,'201':'F'*4+'B'+'F'*9,'202':'F'*4+'?'+'F'*9}
        tiers=lambda room:plan.recommendation_tier(dict(kind='full',room=room,start=6,end=10),rooms)
        self.assertEqual([tiers(r) for r in rooms],[2,1,3,3])
        result=plan.analyze({'building':'三号楼','date':'2026-10-29','rows':[dict(room=r,slots=s) for r,s in rooms.items()]})
        self.assertEqual([r['room'] for r in result['sessions']['下午']['recommendations'][:4]],['106','105','201','202'])
        self.assertEqual(plan.recommendation_tier(dict(kind='route',start=6,end=10),rooms),4)
        self.assertEqual(plan.recommendation_tier(dict(kind='partial',room='105',start=6,end=8),rooms),5)


class RecommendationTests(unittest.TestCase):
    def test_small_comfort_beats_released_ordinary_and_retains_levels(self):
        data=snapshot();set_busy(data,'201',8);set_busy(data,'106',8)
        report=recommend(data,dict(limit=12),'2026-10-29T16:36:00+08:00')
        self.assertEqual(report['candidates'][0]['room'],'106')
        self.assertEqual(report['candidates'][0]['tier'],1)
        self.assertEqual(next(r for r in report['candidates'] if r['room']=='105')['tier'],2)
        self.assertEqual(next(r for r in report['candidates'] if r['room']=='201')['tier'],3)

    def test_release_ten_minute_boundary_and_no_elapsed_window(self):
        data=snapshot();set_busy(data,'106',8)
        for clock,pending,released,tier in [('16:24:59',False,False,5),('16:25:00',True,False,1),('16:35:00',False,True,1),('17:20:00',False,True,1)]:
            # Isolate the room so the top-N bound cannot hide a short-time option.
            isolated={**data,'rooms':[r for r in data['rooms'] if r['room']=='106']}
            row=recommend(isolated,{},'2026-10-29T'+clock+'+08:00')['candidates'][0]
            self.assertEqual(row['release_pending'],pending)
            self.assertEqual(row['just_released'],released)
            self.assertEqual(row['tier'],tier)
            if pending:self.assertFalse(row['available_now']);self.assertEqual(row['usable_from'],'16:35')

    def test_same_tier_released_then_pending_then_continuously_free(self):
        data=snapshot();set_busy(data,'106',11);set_busy(data,'107',10)
        rows=recommend(data,{},'2026-10-29T19:40:00+08:00')['candidates']
        self.assertEqual([r['room'] for r in rows[:3]],['107','106','105'])
        self.assertTrue(rows[0]['just_released']);self.assertTrue(rows[1]['release_pending'])
        self.assertTrue(all(r['tier']==1 for r in rows[:3]))

    def test_pending_release_crosses_noon_and_evening(self):
        for period,clock,label in [(5,'12:10','下午'),(10,'18:10','晚上')]:
            data=snapshot();set_busy(data,'106',period)
            report=recommend(data,{},'2026-10-29T'+clock+':00+08:00')
            self.assertEqual(report['session'],label)
            self.assertEqual(report['candidates'][0]['room'],'106')
            self.assertTrue(report['candidates'][0]['release_pending'])

    def test_many_evening_options_use_unique_real_rooms_and_exclude_current_and_blacklist(self):
        report=recommend(snapshot(),dict(session='evening',limit=12,exclude_room='105'),'2026-10-29T16:00:00+08:00')
        self.assertTrue(report['ok']);self.assertEqual(len(report['candidates']),12)
        ids=[r['room'] for r in report['candidates']]
        self.assertEqual(len(ids),len(set(ids)));self.assertNotIn('105',ids);self.assertNotIn('204',ids)
        self.assertFalse(report['candidates'][0]['available_now'])
        self.assertIn('稍后可用',report['message']);self.assertIn('09:00',report['message'])

    def test_afternoon_entry_is_previous_lesson_end_not_1400(self):
        data=snapshot();set_busy(data,'106',5)
        for clock,available,opening in [('11:00:00',False,'12:15'),('12:15:00',True,'12:15'),('13:00:00',True,'13:00'),('14:20:00',True,'14:20')]:
            report=recommend(data,dict(session='afternoon',limit=12),'2026-10-29T'+clock+'+08:00')
            row=next(r for r in report['candidates'] if r['room']=='106')
            self.assertEqual(row['available_now'],available)
            self.assertEqual(row['usable_from'],opening)
        # Another occupied lesson still prevents early entry.
        data=snapshot();set_busy(data,'106',6)
        data['rooms']=[r for r in data['rooms'] if r['room']=='106']
        row=next(r for r in recommend(data,dict(session='afternoon',limit=12),'2026-10-29T13:00:00+08:00')['candidates'] if r['room']=='106')
        self.assertFalse(row['available_now']);self.assertEqual(row['usable_from'],'14:45')

    def test_change_now_uses_beijing_clock_and_clips_elapsed_periods(self):
        data=snapshot();set_busy(data,'105',13)
        report=recommend(data,dict(session='now'),'2026-10-29T13:01:00Z')
        self.assertEqual(report['session'],'晚上')
        self.assertTrue(report['candidates'][0]['available_now'])
        self.assertEqual(report['candidates'][0]['usable_from'],'21:01')
        self.assertEqual(report['candidates'][0]['start_period'],13)
        self.assertNotEqual(report['candidates'][0]['room'],'105')
        self.assertNotIn('19:00—',report['message'])

    def test_afternoon_cache_rank_has_new_first_tier(self):
        data=snapshot();set_busy(data,'201',5)
        report=recommend(data,dict(session='afternoon'),'2026-10-29T15:00:00+08:00')
        self.assertEqual(report['candidates'][0]['room'],'105');self.assertEqual(report['candidates'][0]['tier'],2)
        self.assertEqual(report['candidates'][1]['tier'],2)

    def test_past_session_day_finished_cache_missing_or_expired_do_not_make_up_options(self):
        for data,args,now,code in [
            (None,{},'2026-10-29T16:00:00+08:00','CAMPUS_CACHE_EMPTY'),
            (snapshot(),dict(session='morning'),'2026-10-29T16:00:00+08:00','CAMPUS_SESSION_FINISHED'),
            (snapshot(),{},'2026-10-29T22:16:00+08:00','CAMPUS_DAY_FINISHED'),
            (snapshot(),dict(date='2026-10-29'),'2026-10-30T16:00:00+08:00','CAMPUS_DATE_PASSED'),
            ({**snapshot(),'fetched_at':'2026-10-28T08:00:00+08:00'},{},'2026-10-29T16:00:00+08:00','CAMPUS_CACHE_EXPIRED'),
        ]:
            with self.subTest(code=code):
                report=recommend(data,args,now);self.assertEqual(report['code'],code);self.assertEqual(report['candidates'],[])

    def test_tool_rejects_user_clock_and_unbounded_amount_and_worker_never_collects(self):
        tool=build_recommendation_tool(snapshot(),'2026-10-29T16:00:00+08:00')
        for args in [dict(limit=13),dict(now='2000-01-01'),dict(exclude_room='../105')]:
            with self.assertRaises(Exception):tool.invoke(args)
        result=campus_worker.process(dict(type='campus',mode='recommend',args=dict(session='evening'),snapshot=snapshot(),now='2026-10-29T16:00:00+08:00'),collector=lambda *_:self.fail('no crawling'))
        self.assertTrue(result['recommendation']['ok']);self.assertNotIn('credentials',result)

    def test_empty_or_excluded_only_snapshots_return_explicit_no_candidates(self):
        for records in [[],[r for r in snapshot()['rooms'] if r['room']=='204']]:
            report=recommend({**snapshot(),'rooms':records},{},'2026-10-29T16:00:00+08:00')
            self.assertEqual(report['code'],'CAMPUS_NO_CANDIDATES');self.assertEqual(report['candidates'],[])


class ModelAdviceTests(unittest.TestCase):
    def report(self):return recommend(snapshot(),dict(session='evening'),'2026-10-29T16:00:00+08:00')

    def advice(self,answer,access='white'):
        model=ScriptedModel(responses=[AIMessage(content=answer)])
        runner=agent_worker.build_runner(model_factory=lambda _c:model,rpc_callback=lambda *_:self.fail('no tools during explanation'))
        request=packet(text='推荐一下晚上的教室，多推荐几个',context={'scope':'group','access':access})
        request.update(type='campus_advice',report=self.report())
        return runner.run(request),model

    def test_explainer_has_no_tools_and_fixed_candidates_and_timestamps_are_always_shown(self):
        result,model=self.advice('可以先选105，小教室更适合安静自习，到了开放时间再进去。')
        self.assertEqual(result['source'],'campus-recommendation');self.assertTrue(result['model_explained'])
        self.assertEqual(model.bound,[]);self.assertEqual(len(model.seen),1)
        self.assertIn('16:00',result['text']);self.assertIn('09:00',result['text'])
        for item in self.report()['candidates']:self.assertIn(item['room'],result['text'])

    def test_fabricated_room_or_time_falls_back_to_verified_facts(self):
        result,_=self.advice('去999，18:00已经可用。')
        self.assertFalse(result['model_explained']);self.assertNotIn('999',result['text']);self.assertNotIn('18:00',result['text'])
        self.assertEqual(verified_explanation(self.report(),'我已占座105。'),'')

    def test_gray_cannot_request_explanation_or_bind_cached_tool(self):
        result,model=self.advice('去105。',access='gray')
        self.assertEqual(result['kind'],'error');self.assertEqual(model.seen,[])
        model=ScriptedModel(responses=[call('buaa_classroom_recommend',dict(session='evening'))])
        runner=agent_worker.build_runner(model_factory=lambda _c:model,rpc_callback=lambda *_:self.fail('gray denied'))
        runner.run(packet(text='推荐晚上的教室',context={'scope':'group','access':'gray','currentSpeaker':'member-abcd','groupContext':[]}))
        self.assertNotIn('buaa_classroom_recommend',model.bound[0])


if __name__=='__main__':unittest.main()
