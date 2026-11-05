import unittest,copy
from unittest.mock import patch
from pydantic import ValidationError
from outdoor_places import parse,search_outdoor_places

def feature(name='措玉村',ident=1,key='place',kind='hamlet',coords=None):
 return {'properties':{'name':name,'osm_type':'N','osm_id':ident,'osm_key':key,'osm_value':kind,'country':'中国','state':'西藏自治区','county':'洛扎县'},'geometry':{'type':'Point','coordinates':coords or [90.79,28.23]}}
class OutdoorPlacesTests(unittest.TestCase):
 def test_village_and_coordinates(self):
  r=parse({'features':[feature()]},'措玉村');self.assertEqual(r[0]['longitude'],90.79);self.assertIn('洛扎县',r[0]['name'])
 def test_wrong_province_and_fuzzy_hits_rejected(self):
  self.assertEqual(parse({'features':[feature()]},'青海 措玉村'),[])
  self.assertEqual(parse({'features':[feature('措玉商店',key='shop',kind='convenience')]},'措玉'),[])
  self.assertEqual(parse({'features':[feature('另一个村')]},'措玉村'),[])
 def test_ambiguous_names_not_first_match(self):
  self.assertEqual(len(parse({'features':[feature(),feature(ident=2)]},'措玉村')),2)
 def test_hiking_representative_label(self):
  r=parse({'features':[feature('古道',key='highway',kind='path')]},'古道');self.assertIn('步道代表点',r[0]['name'])
 def test_bad_coordinates_not_used(self):
  for xy in [[True,23],[200,23],[90,float('nan')]]:
   with self.assertRaises(ValueError):parse({'features':[feature(coords=xy)]},'措玉村')
 def test_restricted_tool_real_invoke(self):
  with patch('outdoor_places.fetch',return_value={'features':[feature()]}) as fetch:
   self.assertEqual(len(search_outdoor_places.invoke({'query':'措玉村'})['places']),1)
   for query in ['https://localhost/','../密钥','村\n庄']:
    self.assertEqual(search_outdoor_places.invoke({'query':query})['error'],'LOCATION_INPUT_INVALID')
   self.assertEqual(fetch.call_count,1)
   with self.assertRaises(ValidationError):search_outdoor_places.invoke({'query':'村','url':'https://localhost'})
 def test_unavailable_not_empty(self):
  with patch('outdoor_places.fetch',side_effect=OSError('private details')):
   self.assertEqual(search_outdoor_places.invoke({'query':'措玉村'}),{'error':'LOCATION_SOURCE_UNAVAILABLE'})
if __name__=='__main__':unittest.main()
