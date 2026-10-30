import json
import unittest
from langchain_core.messages import AIMessage
from conversation_insights import extract,build_insight_tool

class Model:
    def __init__(self,data):self.data=data
    def invoke(self,_):return AIMessage(content=json.dumps(self.data,ensure_ascii=False))

class InsightTests(unittest.TestCase):
    def test_contextual_frustration_has_verbatim_evidence(self):
        result=extract(['今天活好多','好好好又让我加班是吧'],{},lambda _:Model({'mood':{'label':'烦躁','evidence':'又让我加班','confidence':.9},'habits':[]}))
        self.assertEqual(result['mood']['label'],'烦躁')
    def test_invented_evidence_or_low_confidence_is_discarded(self):
        for evidence,confidence in [('很难过',.9),('普通聊天',.4)]:
            r=extract(['普通聊天'],{},lambda _:Model({'mood':{'label':'难过','evidence':evidence,'confidence':confidence}}))
            self.assertIsNone(r['mood'])
    def test_repeated_habit_needs_two_different_messages(self):
        def result(evidence):return extract(['哈哈饭碗归鱼','嘿嘿今天吃两碗'],{},lambda _:Model({'habits':[{'label':'常用玩笑表达','evidence':evidence}]}))
        self.assertEqual(len(result(['哈哈','嘿嘿'])['habits']),1)
        self.assertEqual(result(['哈哈','饭碗'])['habits'],[])
    def test_a_statement_does_not_count_as_a_repeated_rhetorical_question(self):
        r=extract(['今天写了一天','好好好又让我加班是吧'],{},lambda _:Model({'habits':[{'label':'常用反问','evidence':['今天写了一天','又让我加班是吧']}]}))
        self.assertEqual(r['habits'],[])
    def test_sensitive_text_and_model_personality_labels_are_rejected(self):
        r=extract(['我有抑郁症'],{},lambda _:self.fail('Sensitive input must not be analysed'))
        self.assertIsNone(r['mood'])
        with self.assertRaises(Exception):extract(['你好'],{},lambda _:Model({'habits':[{'label':'精神有问题','evidence':['你好','你好']}]}))
    def test_langchain_interface_has_no_other_person_or_path_parameter(self):
        t=build_insight_tool(['我很开心'],{},lambda _:Model({'mood':None,'habits':[]}))
        self.assertTrue(t.invoke({})['ok'])
        with self.assertRaises(Exception):t.invoke({'namespace':'other'})

if __name__=='__main__':unittest.main()
