import json
import sys
import tempfile
import unittest
from pathlib import Path

APP=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(APP/'ops'))
from map_review import require_map_review


class MapReviewTests(unittest.TestCase):
    def test_old_rendered_dashes_all_have_source_receipts(self):
        data=json.loads((APP/'data/weather-boundary-review.json').read_bytes())
        items=data['items'];self.assertEqual(len({i['neId'] for i in items}),40)
        rendered=[i for i in items if i['oldSymbol']=='虚线']
        self.assertEqual(len(rendered),33)
        self.assertEqual(len({n for i in rendered for n in i['oldTileIds']}),36)
        indefinite=[i for i in items if i['rawClass']=='Indeterminant frontier']
        self.assertEqual([i['oldSymbol'] for i in indefinite],['实线','实线'])
        wrong=next(i for i in items if i['neId']==1746705337)
        self.assertGreater(wrong['fractionInsideOfficialTibet'],.99)

    def test_hold_blocks_changed_assets_but_allows_identical_map_revision(self):
        require_map_review(APP)
        require_map_review(APP,APP)
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'data').mkdir()
            (root/'data/weather-map.zip').write_bytes(b'changed')
            (root/'data/weather-boundary-review.json').write_text(json.dumps({
                'state':'approved','items':[],'additionalChecks':[],'approvedAssetHashes':{}}))
            with self.assertRaisesRegex(ValueError,'MAP_PUBLICATION_ON_HOLD'):
                require_map_review(root,APP)
