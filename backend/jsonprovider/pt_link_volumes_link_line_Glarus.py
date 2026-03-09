import json

from pyasn1.type import tag

from jsonprovider.DataProvider import FileProvider


class pt_link_volumes_link_line_Glarus(FileProvider):
    FILE = "age.json"

    def deliver(self, flt):
        limit = int(flt.get("limit", "10"))
        tag = flt.get("tag")
        return "trued"
        #data = json.loads(open("test.json", "r", encoding="utf-8").read())

        #if tag:
        #    data = [x for x in data if x.get("tag") == tag]

        #return data[:limit]