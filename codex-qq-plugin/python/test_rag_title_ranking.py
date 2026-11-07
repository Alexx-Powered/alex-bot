"""Explicit subjects survive generic-term saturation without widening scope."""
from pathlib import Path
import tempfile
import unittest
import uuid

from rag_store import RagStore
from rag_retriever import RagRetriever
import test_rag_retriever as fixtures


class TitleRankingTests(unittest.TestCase):
    def setUp(self):
        parent=Path(__file__).resolve().parents[1]/'test-output/rag-tests'
        parent.mkdir(parents=True,exist_ok=True)
        self.temp=tempfile.TemporaryDirectory(dir=parent)
        self.addCleanup(self.temp.cleanup)
        self.now=1000.
        self.store=RagStore(Path(self.temp.name)/'rag.sqlite3',clock=lambda:self.now)
        self.index=fixtures.StubIndex()
        self.rag=RagRetriever(self.store,self.index,fixtures.StubEmbedding(),clock=lambda:self.now)

    def put(self,title,text,namespace='alice',domain='outdoor',**kwargs):
        kwargs.setdefault('doc_id',uuid.uuid4().hex)
        return self.store.put_document(namespace=namespace,domain=domain,title=title,text=text,
            source_ref='fixture:subject-ranking',**kwargs)

    def search(self,query,**kwargs):
        return self.rag.search(query,namespace='alice',domain='outdoor',**kwargs)

    def distractors(self):
        return [self.put(f'其他山地{i}｜路线介绍','徒步路线的景观、季节和开放公告有哪些依据？')
                for i in range(16)]

    def test_named_small_place_survives_more_than_top_k_generic_hits(self):
        target=self.put('青岚谷｜高山湖泊','主要景观为冰川和湖泊。')
        generic=self.distractors()
        query='青岚谷徒步路线的景观、季节和开放公告有哪些依据？'
        result=self.search(query,mode='lexical',limit=4)
        ids=[r['doc_id'] for r in result['evidence']]
        self.assertEqual(ids[0],target['doc_id'])
        # Subject priority is a ranking signal, not a hard filter for other knowledge.
        self.assertEqual(len(ids),4)
        self.assertTrue(set(ids[1:]).issubset({d['doc_id'] for d in generic}))

    def test_fusion_does_not_bury_subject_seen_only_by_lexical_channel(self):
        target=self.put('青岚谷｜湖泊','冰川与湖泊。')
        generic=self.distractors()
        ids={d['doc_id'] for d in generic[:12]}
        # Simulate semantic top-k dominated by generic route wording; the exact
        # subject is absent from the vector candidate list, not given fake scores.
        self.index.rows={r['record_id']:r for r in self.store.active_chunks(namespace='alice',domain='outdoor')
                         if r['doc_id'] in ids}
        result=self.search('青岚谷徒步路线的景观、季节和开放公告有哪些依据？',limit=4)
        self.assertEqual(result['evidence'][0]['doc_id'],target['doc_id'])
        self.assertEqual(result['answer_status'],'not_assessed')
        self.assertEqual(self.rag.min_score,0.45)

    def test_complete_specific_route_beats_parent_place(self):
        broad=self.put('青岚山｜路线景观与开放','青岚山北线徒步路线的景观和开放公告。')
        branch=self.put('青岚山北线｜森林段','针叶林与溪谷。')
        result=self.search('青岚山北线徒步路线的景观和开放公告',mode='lexical')
        self.assertEqual(result['evidence'][0]['doc_id'],branch['doc_id'])
        self.assertIn(broad['doc_id'],[r['doc_id'] for r in result['evidence']])

    def test_latin_boundaries_case_width_and_spacing_keep_literal_subjects(self):
        york=self.put('York｜Trails','Yorkshire trail access landscape weather.')
        target=self.put('Yorkshire｜Trails','Moorland.')
        result=self.search('YORKSHIRE trail access landscape weather',mode='lexical')
        self.assertEqual(result['evidence'][0]['doc_id'],target['doc_id'])
        self.assertIn(york['doc_id'],[r['doc_id'] for r in result['evidence']])
        city=self.put('Ｎｅｗ Ｙｏｒｋ｜Walks','Public paths.')
        self.assertEqual(self.search('new   york walks',mode='lexical')['evidence'][0]['doc_id'],city['doc_id'])
        # Full-width query text follows the same canonical lexical normalization.
        self.assertEqual(self.search('ＮＥＷ ＹＯＲＫ',mode='lexical')['evidence'][0]['doc_id'],city['doc_id'])

    def test_generic_knowledge_query_does_not_need_named_destination(self):
        generic=self.put('户外｜衣物与雨具','徒步装备采用排汗、保暖、防雨分层。')
        self.put('青岚谷｜风景','湖泊和森林。')
        result=self.search('徒步装备防雨分层',mode='lexical')
        self.assertEqual([r['doc_id'] for r in result['evidence']],[generic['doc_id']])

    def test_chinese_route_joiners_are_optional_but_latin_hyphens_are_not(self):
        route=self.put('长坪沟—毕棚沟｜跨沟路线','森林和草甸。')
        self.distractors()
        for name in ('长坪沟毕棚沟','长坪沟—毕棚沟','长坪沟 – 毕棚沟','长坪沟 - 毕棚沟'):
            with self.subTest(name=name):
                result=self.search(name+'徒步路线的景观和开放公告',mode='lexical')
                self.assertEqual(result['evidence'][0]['doc_id'],route['doc_id'])
        # Even a two-character joined subject can be found when none of the
        # original, unnormalized bigrams match the title or body.
        short=self.put('甲—乙｜连接线','步道。')
        self.assertEqual(self.search('甲乙',mode='lexical')['evidence'][0]['doc_id'],short['doc_id'])
        dashed=self.put('North-Ridge｜Access','Forest.')
        joined=self.put('NorthRidge｜Access','Lake.')
        self.assertEqual([r['doc_id'] for r in self.search('NorthRidge',mode='lexical')['evidence']],[joined['doc_id']])
        self.assertEqual([r['doc_id'] for r in self.search('North-Ridge',mode='lexical')['evidence']],[dashed['doc_id']])

    def test_subject_priority_cannot_bypass_scope_or_validity(self):
        shared=self.put('青岚谷｜共享资料','森林。',namespace='shared',visibility='shared')
        forbidden=[
            self.put('青岚谷｜别人的计划','森林。',namespace='bob'),
            self.put('青岚谷｜其他领域','森林。',domain='weather'),
            self.put('青岚谷｜过期资料','森林。',valid_until=900),
            self.put('青岚谷｜未来资料','森林。',valid_from=1100),
        ]
        self.rag.process_outbox()
        self.assertEqual(self.search('青岚谷路线')['evidence'],[])
        result=self.search('青岚谷路线',include_shared=True)
        self.assertEqual([r['doc_id'] for r in result['evidence']],[shared['doc_id']])
        self.assertFalse({d['doc_id'] for d in forbidden}&{r['doc_id'] for r in result['evidence']})

    def test_revised_title_and_deleted_source_never_keep_old_priority(self):
        old=self.put('青岚谷｜旧主题','旧资料。')
        self.rag.process_outbox()
        self.put('赤石谷｜新主题','新资料。',doc_id=old['doc_id'])
        self.assertEqual(self.search('青岚谷')['evidence'],[])
        current=self.search('赤石谷',mode='lexical')['evidence']
        self.assertEqual(current[0]['revision'],2)
        self.store.delete_document(old['doc_id'],namespace='alice')
        self.assertEqual(self.search('赤石谷')['evidence'],[])
        self.assertEqual(self.rag.validate_evidence(current,namespace='alice',domain='outdoor'),[])

    def test_delete_between_candidate_ranking_and_final_verification(self):
        target=self.put('青岚谷｜当前资料','森林。')
        embedding=fixtures.StubEmbedding()
        def embed_query(query):
            self.store.delete_document(target['doc_id'],namespace='alice')
            return [1.,0.]
        embedding.embed_query=embed_query
        retriever=RagRetriever(self.store,self.index,embedding,clock=lambda:self.now)
        result=retriever.search('青岚谷',namespace='alice',domain='outdoor')
        self.assertEqual(result['evidence'],[])


if __name__=='__main__': unittest.main()
