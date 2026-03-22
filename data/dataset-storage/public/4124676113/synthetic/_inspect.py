import duckdb
con = duckdb.connect()
# persons
print(con.execute("SELECT * FROM read_parquet('persons.parquet') LIMIT 1").description)
# households
print(con.execute("SELECT * FROM read_parquet('households.parquet') LIMIT 1").description)