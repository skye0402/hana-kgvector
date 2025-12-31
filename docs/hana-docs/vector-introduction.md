Introduction
============

The SAP HANA Cloud vector engine offers multiple use cases in AI scenarios.

Recent advances in Generative AI (GenAI) and Large Language Models (LLM) have led to increased awareness of and popularity for vector databases. Similarity search, a key functionality of vector databases, complements traditional relational databases as well as full-text search systems. Using natural language text as an example, embedding functions map data to high dimensional vectors to preserve their semantic similarity. Developers can then use vector-based semantic search to find similarity between different passages of text. Because the data within an LLM is current only up to a specific point in time, vector databases can offer additional relevant text to make searches more accurate – known as Retrieval Augmented Generation (RAG). Therefore, the addition of RAG to an LLM using a vector database like SAP HANA Cloud provides an effective approach to increase the quality of responses from an LLM.

The SAP HANA Cloud vector engine supports the create, read, update, and delete (CRUD) operations involving vectors using SQL. The ability to determine similarity among vectors enables use cases such as the following:

*   Semantic search
    
*   Natural language processing (NLP)
    
*   Retrieval Augmented Generation (RAG)
    
*   Similarity search
    
*   Recommendations
    
*   Classifications
    
*   Clustering
    
*   Anomaly detection
    

Key benefits of the SAP HANA Cloud vector engine include the following:

*   Simplify the data architecture, management, and security with the storage of vectors and other enterprise data within the same database.
    
*   Interact with all types of data (including vectors) using SQL.
    
*   Gain new insights into data by combining spatial, graph, JSON, and custom SQLScript with vector-based queries.
    
*   Incorporate vector use cases in solutions with the SAP HANA Cloud clients (including Python), the Python Machine Learning Client for SAP HANA (hana-ml), and the SAP Cloud Application Programming Model (CAP).

REAL\_VECTOR and HALF\_VECTOR Data Types
========================================

The SAP HANA Cloud database has the built-in vector data types REAL\_VECTOR and HALF\_VECTOR:

*   The REAL\_VECTOR(<n>) data type specifies a vector type with REAL (IEEE 754 single-precision floating-point) elements. The optional <n> indicates the vector dimension and is an integer between 1 and 65,000. If the dimension is not specified in DDL or DML statements, any dimension in the valid range can be assigned to the vector instance.
    
*   The HALF\_VECTOR(<n>) data type specifies a vector type with IEEE 754 half-precision floating-point elements. The optional <n> indicates the vector dimension and is an integer between 1 and 65,000. If the dimension is not specified in DDL or DML statements, any dimension in the valid range can be assigned to the vector instance.
    
    Compared to REAL\_VECTOR elements, HALF\_VECTOR elements have a reduced precision and a reduced value range. This may lead to unexpected results:
    
        SELECT
            TO_NVARCHAR(MEMBER_AT(TO_REAL_VECTOR('[0.3]'), 1)),
            TO_NVARCHAR(MEMBER_AT(TO_HALF_VECTOR('[0.3]'), 1))
        FROM DUMMY;
        
        returns:
        0.3   0.30004883
    
        SELECT
            TO_NVARCHAR(TO_REAL_VECTOR('[33333]')),
            TO_NVARCHAR(TO_HALF_VECTOR('[33333]'))
        FROM DUMMY;
        
        returns:
        [33333]   [33344]
    

The REAL\_VECTOR and HALF\_VECTOR data types can be used like any other SAP HANA SQL data type, for example in arithmetic expressions (see [Vector Columns in Arithmetic Expressions](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-vector-engine-guide/calculations-with-vectors?locale=en-US&state=PRODUCTION&version=2025_4_QRC "You use arithmetic operators to perform mathematical operations, such as adding, subtracting, multiplying by a scalar and negation of vectors.")).

Limitations on Vector Data Types
--------------------------------

Vector data types have some limitations that are similar to the limitations of LOB (BLOB and NCLOB) data types:

*   There is no order defined on vector data types. All operations relying on ordering, such as grouping, ordering, comparison, and so on, can't be used on vectors.
    
*   Vector columns are not supported in row tables.
    
*   Vector columns cannot be used as partitioning key when partitioning tables.

Constructing and Serializing Vectors
====================================

Vectors can be constructed and serialized.

The TO\_REAL\_VECTOR and TO\_HALF\_VECTOR functions can construct a vector from the following:

*   A textual representation
    
*   A binary representation
    
*   An array consisting of numerical elements
    

A vector can be serialized to the following:

*   A textual representation with TO\_NVARCHAR or TO\_NCLOB
    
*   A binary representation with TO\_VARBINARY or TO\_BLOB
    
*   An array consisting of REAL elements with TO\_ARRAY
    

The textual format of a vector is:

    '[' <number> ( ',' <number> )* ']'
    for example:
    [0.342, 0.163, 0.426]

REAL\_VECTOR
------------

The binary format of a vector with data type REAL\_VECTOR starts with a 32-bit little-endian integer n that describes the dimension of the vector followed by n little-endian IEEE 754 single-precision floating-point numbers representing the vector elements. The hexadecimal encoded representation could look like this: 03000000 0000803F 00000040 00004040.

The following examples show how to construct the vector (1, 2, 3) from a textual, binary, and array representation:

    SELECT TO_REAL_VECTOR('[1,2,3]') FROM DUMMY;
    SELECT TO_REAL_VECTOR(x'030000000000803F0000004000004040') FROM DUMMY;
    SELECT TO_REAL_VECTOR(ARRAY(1,2,3)) FROM DUMMY;

When you select a vector with REAL\_VECTOR data type the system transfers the vector to the client in binary format. The binary format enables efficient data processing. The following examples show how to get a textual or array representation of a vector:

    SELECT TO_NVARCHAR(TO_REAL_VECTOR(ARRAY(1,2,3))) FROM DUMMY;
    SELECT TO_ARRAY(TO_REAL_VECTOR('[1,2,3]')) FROM DUMMY;

HALF\_VECTOR
------------

The binary format of a vector with data type HALF\_VECTOR starts with a 32-bit little-endian integer n that describes the dimension of the vector followed by n little-endian IEEE 754 half-precision floating-point numbers representing the vector elements. The hexadecimal encoded representation could look like this: 03000000 003C 0040 0042.

The following examples show how to construct the vector (1, 2, 3) from a textual, binary, and array representation:

    SELECT TO_HALF_VECTOR('[1,2,3]') FROM DUMMY;
    SELECT TO_HALF_VECTOR(x'03000000003C00400042') FROM DUMMY;
    SELECT TO_HALF_VECTOR(ARRAY(1,2,3)) FROM DUMMY;

When you select a vector with HALF\_VECTOR data type the system transfers the vector to the client in binary format. The binary format enables efficient data processing. The following examples show how to get a textual or array representation of a vector:

    SELECT TO_NVARCHAR(TO_HALF_VECTOR(ARRAY(1,2,3))) FROM DUMMY;
    SELECT TO_ARRAY(TO_HALF_VECTOR('[1,2,3]')) FROM DUMMY;

Creating Tables with REAL\_VECTOR or HALF\_VECTOR Columns
=========================================================

Tables with REAL\_VECTOR or HALF\_VECTOR columns are created like regular tables.

When you create tables with vector columns, you can specify an optional dimension constraint on vector columns. Those columns accept vectors with that dimension only.

The following example creates a table with two vector columns. The first vector column accepts vectors with any dimension, while the second vector column accepts vectors with dimension 3 only:

    CREATE COLUMN TABLE VECTORTAB (ID INT, V1 REAL_VECTOR, V2 REAL_VECTOR(3));

**Note**

REAL\_VECTOR columns and HALF\_VECTOR columns are not supported in row tables.

Inserting, Updating, and Deleting Vectors
=========================================

Vectors are inserted, updated, and deleted like any other data type.

However, there are no implicit conversions to REAL\_VECTOR or HALF\_VECTOR. Therefore, a vector must be constructed first, as described in [Constructing and Serializing Vectors](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-vector-engine-guide/constructing-and-serializing-vectors?locale=en-US&state=PRODUCTION&version=2025_4_QRC "Vectors can be constructed and serialized."), before it can be inserted.

The following example creates a table with a vector column and inserts two vectors into it:

    CREATE TABLE VECTORTAB (ID INT, V REAL_VECTOR(3));
    INSERT INTO VECTORTAB VALUES (1, TO_REAL_VECTOR('[2,3,5]'));
    INSERT INTO VECTORTAB VALUES (2, TO_REAL_VECTOR('[7,11,13]'));

The following queries update the vector with ID 1 and delete the vector with ID 2:

    UPDATE VECTORTAB SET V = TO_REAL_VECTOR('[17,19,23]') WHERE ID = 1;
    DELETE FROM VECTORTAB WHERE ID = 2;

If a large number of vectors is to be inserted into a column, it is recommended to use parametrized statements combined with batch inserts.

The following examples, for REAL\_VECTOR and HALF\_VECTOR, show how batch inserts with parameterized statements can be used in Python. The examples connect to an SAP HANA database, create a table, and insert three rows via a parameterized batch insert. Then they fetch all rows again and print them to the console.

Example for REAL\_VECTOR

    from hdbcli import dbapi
    
    conn = dbapi.connect(
        address=<hostname>,
        port=443,
        user=<username>,
        password=<password>
    )
    conn.setautocommit(False)
    cursor = conn.cursor()
    cursor.execute("CREATE TABLE TAB_REAL (ID INT, TEXT NCLOB, EMB REAL_VECTOR(3))")
    
    rows = [
        (1, "Text 1", "[1,2,3]"),
        (2, "Text 2", "[2,3,4]"),
        (3, "Text 3", "[3,4,5]")
    ]    
    cursor.executemany("INSERT INTO TAB_REAL VALUES (?, ?, TO_REAL_VECTOR(?))", rows)
    conn.commit()
    
    cursor.execute("SELECT ID, TEXT, TO_NVARCHAR(EMB) FROM TAB_REAL")
    for row in cursor:
        print(row)

Example for HALF\_VECTOR

    from hdbcli import dbapi
    
    conn = dbapi.connect(
        address=<hostname>,
        port=443,
        user=<username>,
        password=<password>
    )
    conn.setautocommit(False)
    cursor = conn.cursor()
    cursor.execute("CREATE TABLE TAB_HALF (ID INT, TEXT NCLOB, EMB HALF_VECTOR(3))")
    
    rows = [
        (1, "Text 1", "[1,2,3]"),
        (2, "Text 2", "[2,3,4]"),
        (3, "Text 3", "[3,4,5]")
    ]    
    cursor.executemany("INSERT INTO TAB_HALF VALUES (?, ?, TO_HALF_VECTOR(?))", rows)
    conn.commit()
    
    cursor.execute("SELECT ID, TEXT, TO_NVARCHAR(EMB) FROM TAB_HALF")
    for row in cursor:
        print(row)

For information about using the hdbcli Python module, see [Python Application Programming](https://help.sap.com/docs/SAP_HANA_CLIENT/f1b440ded6144a54ada97ff95dac7adf/f3b8fabf34324302b123297cdbe710f0.html?version=2.19 "https://help.sap.com/docs/SAP_HANA_CLIENT/f1b440ded6144a54ada97ff95dac7adf/f3b8fabf34324302b123297cdbe710f0.html?version=2.19").

Performing Similarity Searches
==============================

The most common operations on vector columns are top-k nearest-neighbor searches.

For a given query vector, the task is to find the k most similar vectors in a column in relation to a specific similarity measure.

L2DISTANCE

A typical query finding the top 20 most similar vectors using the L2 distance metric could look like this (with the query vector as a parameter):

    SELECT TOP 20 *
    FROM VECTORTAB
    ORDER BY L2DISTANCE(EMBEDDING, TO_REAL_VECTOR(?));

COSINE\_SIMILARITY

It is also possible to add further filters (CATEGORY) to the query. The following query uses the cosine similarity measure to find the 20 most similar vectors after applying a filter to the vector table (with the query vector as a parameter):

    SELECT TOP 20 *
    FROM VECTORTAB
    WHERE CATEGORY = 2
    ORDER BY COSINE_SIMILARITY(EMBEDDING, TO_REAL_VECTOR(?)) DESC;

**Note**

DESC in the ORDER BY clause is required, because more similar vectors have a higher cosine similarity.

Limitations
===========

In some cases, similarity searches have limitations.

The similarity measures functions use IEEE 754 single-precision floating-point arithmetic. If vectors with very large elements are passed to similarity measures, a numeric overflow could occur. In this case, the function returns NULL instead of the actual similarity measure:

    -- Returns NULL
    SELECT L2DISTANCE(
        TO_REAL_VECTOR('[ 1e20,  1e20]'),
        TO_REAL_VECTOR('[-1e20, -1e20]')
    ) FROM DUMMY;

The cosine similarity performs a division by the vector lengths. Therefore, COSINE\_SIMILARITY returns NULL if all elements of a vector are zero. If the elements of a vector are all very small, a numeric underflow can occur. In such a case, COSINE\_SIMILARITY returns NULL as well:

    -- Returns NULL
    SELECT COSINE_SIMILARITY(
        TO_REAL_VECTOR('[1,1]'),
        TO_REAL_VECTOR('[1e-23,1e-23]')
    ) FROM DUMMY;

Similarity measures use the Single Instruction Multiple Data (SIMD) instructions available on the CPU that the SAP HANA Cloud database is running on. The exact order of intermediate result addition varies with different SIMD instructions. This variation can lead to slightly different results. Therefore, executing the same similarity measure on the same vectors can return a slightly different result on different CPU architectures. They're so small that they should not play a role in practice.

Vector Function Reference
=========================

The following SQL functions are related to the data types REAL\_VECTOR and HALF\_VECTOR.

Supported functions:
--------------------

*   [CARDINALITY Function (Vector)](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-vector-engine-guide/cardinality-function-vector?locale=en-US&state=PRODUCTION&version=2025_4_QRC "Returns the dimension of a vector.")
    
*   [COSINE\_SIMILARITY Function (Vector)](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-vector-engine-guide/cosine-similarity-function-vector?locale=en-US&state=PRODUCTION&version=2025_4_QRC "Computes the cosine similarity of two vectors.")
    
*   [L2DISTANCE Function (Vector)](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-vector-engine-guide/l2distance-function-vector?locale=en-US&state=PRODUCTION&version=2025_4_QRC "Computes the L2 distance of two vectors.")
    
*   [L2NORM Function (Vector)](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-vector-engine-guide/l2norm-function-vector?locale=en-US&state=PRODUCTION&version=2025_4_QRC "Computes the length (Euclidean norm) of a vector.")
    
*   [L2NORMALIZE Function (Vector)](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-vector-engine-guide/l2normalize-function-vector?locale=en-US&state=PRODUCTION&version=2025_4_QRC "Changes the length of a vector to 1 while keeping the direction.")
    
*   [MEMBER\_AT Function (Vector)](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-vector-engine-guide/member-at-function-vector?locale=en-US&state=PRODUCTION&version=2025_4_QRC "Returns the vector element at the specified position.")
    
*   [SUBVECTOR Function (Vector)](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-vector-engine-guide/subvector-function-vector?locale=en-US&state=PRODUCTION&version=2025_4_QRC "Returns a subvector from a vector.")
    
*   [TO\_ARRAY Function (Data Type Conversion)](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-vector-engine-guide/to-array-function-data-type-conversion?locale=en-US&state=PRODUCTION&version=2025_4_QRC "Converts a vector to an ARRAY data type.")
    
*   [TO\_BINARY Function (Data Type Conversion)](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-vector-engine-guide/to-binary-function-data-type-conversion?locale=en-US&state=PRODUCTION&version=2025_4_QRC "Converts a value to a BINARY data type.")
    
*   [TO\_BLOB Function (Data Type Conversion)](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-vector-engine-guide/to-blob-function-data-type-conversion?locale=en-US&state=PRODUCTION&version=2025_4_QRC "Converts a binary string, NCLOB (or CLOB which is an alias of NCLOB) or vector data type to a BLOB data type.")
    
*   [TO\_HALF\_VECTOR Function (Data Type Conversion)](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-vector-engine-guide/to-half-vector-function-data-type-conversion?locale=en-US&state=PRODUCTION&version=2025_4_QRC "Constructs a vector from a textual or binary representation, from an array, or a vector with data type REAL_VECTOR.")
    
*   [TO\_NCLOB Function (Data Type Conversion)](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-vector-engine-guide/to-nclob-function-data-type-conversion?locale=en-US&state=PRODUCTION&version=2025_4_QRC "Converts a value to the NCLOB data type.")
    
*   [TO\_NVARCHAR Function (Data Type Conversion)](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-vector-engine-guide/to-nvarchar-function-data-type-conversion?locale=en-US&state=PRODUCTION&version=2025_4_QRC "Converts a given value to an NVARCHAR data type, with an option to format the output value.")
    
*   [TO\_REAL\_VECTOR Function (Data Type Conversion)](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-vector-engine-guide/to-real-vector-function-data-type-conversion?locale=en-US&state=PRODUCTION&version=2025_4_QRC "Constructs a vector from a textual or binary representation, from an array, or a vector with data type HALF_VECTOR.")
    
*   [TO\_VARBINARY Function (Data Type Conversion)](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-vector-engine-guide/to-varbinary-function-data-type-conversion?locale=en-US&state=PRODUCTION&version=2025_4_QRC "Converts a value to a BINARY data type.")
    
*   [VECTOR\_EMBEDDING Function (Vector)](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-vector-engine-guide/vector-embedding-function-vector?locale=en-US&state=PRODUCTION&version=2025_4_QRC "Creates a vector embedding from a text.")

Working with Test Data
======================

Learn where to get test data, import test data, and use the functions related to the REAL\_VECTOR data type on the test data.

Vector Embeddings Under the Public Domain
-----------------------------------------

Test data for vector embeddings are available under the public domain, for example from the following distributor: [GloVe: Global Vectors for Word Representation![Information published on non-SAP site](https://help.sap.com/doc/c40cab369db246f1a17feea1c031ddc1/2025_4_QRC/en-US/themes/sap-light/img/3rd_link.png "Information published on non-SAP site")](https://help.sap.com/docs/link-disclaimer?site=https%3A%2F%2Fnlp.stanford.edu%2Fprojects%2Fglove%2F "https://nlp.stanford.edu/projects/glove/").

Download the test data and save the test data in a directory intended for this purpose.

**Note**

The test data used in the following examples is provided by [GloVe: Global Vectors for Word Representation![Information published on non-SAP site](https://help.sap.com/doc/c40cab369db246f1a17feea1c031ddc1/2025_4_QRC/en-US/themes/sap-light/img/3rd_link.png "Information published on non-SAP site")](https://help.sap.com/docs/link-disclaimer?site=https%3A%2F%2Fnlp.stanford.edu%2Fprojects%2Fglove%2F "https://nlp.stanford.edu/projects/glove/"). This data is made available under the [Public Domain Dedication and License v1.0![Information published on non-SAP site](https://help.sap.com/doc/c40cab369db246f1a17feea1c031ddc1/2025_4_QRC/en-US/themes/sap-light/img/3rd_link.png "Information published on non-SAP site")](https://help.sap.com/docs/link-disclaimer?site=https%3A%2F%2Fopendatacommons.org%2Flicenses%2Fpddl%2F "https://opendatacommons.org/licenses/pddl/") whose full text can be found at [http://opendatacommons.org/licenses/pddl/1.0/![Information published on non-SAP site](https://help.sap.com/doc/c40cab369db246f1a17feea1c031ddc1/2025_4_QRC/en-US/themes/sap-light/img/3rd_link.png "Information published on non-SAP site")](https://help.sap.com/docs/link-disclaimer?site=http%3A%2F%2Fopendatacommons.org%2Flicenses%2Fpddl%2F1.0%2F "http://opendatacommons.org/licenses/pddl/1.0/"). This data is not included in the SAP HANA Cloud, SAP HANA Database shipment.

Executing Python Scripts on the SAP HANA Cloud Database
-------------------------------------------------------

With the hdbcli Python module, you access and change the data in SAP HANA databases. Download the hdbcli Python module and install on your system. The hdbcli Python module can be downloaded from [https://pypi.org/project/hdbcli/![Information published on non-SAP site](https://help.sap.com/doc/c40cab369db246f1a17feea1c031ddc1/2025_4_QRC/en-US/themes/sap-light/img/3rd_link.png "Information published on non-SAP site")](https://help.sap.com/docs/link-disclaimer?site=https%3A%2F%2Fpypi.org%2Fproject%2Fhdbcli%2F "https://pypi.org/project/hdbcli/")

For information about using the hdbcli Python module, see [Python Application Programming](https://help.sap.com/docs/SAP_HANA_CLIENT/f1b440ded6144a54ada97ff95dac7adf/f3b8fabf34324302b123297cdbe710f0.html?version=2.19 "https://help.sap.com/docs/SAP_HANA_CLIENT/f1b440ded6144a54ada97ff95dac7adf/f3b8fabf34324302b123297cdbe710f0.html?version=2.19").

Python Script for Uploading Vector Embeddings
---------------------------------------------

The following Python script can be used to upload test data (for example, data obtained from the GloVe website) into the SAP HANA Cloud database. The script uses the hdbcli Python module.

The script loads the test data from a file (first command line argument). The script uses an existing schema (second command line argument). The script creates a table (third command line argument). The table has the columns WORD (NVARCHAR(1000)) and EMBEDDING (REAL\_VECTOR data type). Finally, the test data is inserted into the table in batch mode:

    import struct
    import sys
    from hdbcli import dbapi
    
    # Use command line arguments to import individual glove txt files.
    if len(sys.argv) != 4:
        print(f"Usage: {sys.argv[0]} PATH_GLOVE_TXT SCHEMA_NAME TABLE_NAME")
        sys.exit(1)
    _, glove_txt_path, schema_name, table_name = sys.argv
    
    # Connect to database, enter your connection data
    conn = dbapi.connect(
        address=<hostname>,
        port=443,
        user=<username>,
        password=<password>
    )
    
    cursor = conn.cursor()
    
    # Example glove txt file
    # Should be available from here:
    # https://nlp.stanford.edu/projects/glove/
    # the 0.418 0.24968 ... (more numbers)
    # , 0.013441 0.23682 ... (more numbers)
    # ...
    
    dimension = None  # Implicitly contained in glove txt file.
    buffer = [] # Use bulk insert into database.
    num_inserted = 0 # For logging.
    print(f"Reading file '{glove_txt_path}'")
    for line in open(glove_txt_path, encoding="utf-8").read().splitlines():
        # Each line consists of fields, separated by spaces.
        # Example: ["the", "0.418", "0.24968", ...] <-- "the 0.418 0.246968 ..."
        fields = line.split(" ")
        # Each line begins with a word, followed by floating point numbers.
        # Example: "the", [0.418, 0.24968, ...] <-- ["the", "0.418", "0.24968", ...]
        word, values = fields[0], [float(v) for v in fields[1:]]
        if dimension is None: # Set dim from first line and create table.
            dimension = len(values)
            # Create table as soon as we know the vector dimension.
            # Example: "CREATE TABLE "SCHEMA"."TABLE" (WORD NVARCHAR(1000), EMBEDDING REAL_VECTOR(50)"
            cursor.execute(f'CREATE TABLE "{schema_name}"."{table_name}" (WORD NVARCHAR(1000), EMBEDDING REAL_VECTOR({dimension}))')
            print(f'created "{schema_name}"."{table_name}"')
        elif dimension != len(values): # Check if dim matches current line.
            raise RuntimeError(f"Expected equality of {dimension} and {len(values)}")
        # Each element of buffer consists of a word and a vector in the fvecs format.
        # Fvecs data is created using the struct module.
        # Fvecs: http://corpus-texmex.irisa.fr/
        # Bytes are stored in little endian.
        # First 4 bytes store the vector length using an uint32_t
        # Remaining bytes store float vector elements using https://en.wikipedia.org/wiki/Single-precision_floating-point_format
        values_as_fvecs = struct.pack(f"<I{dimension}f", dimension, *values)
        buffer.append([word, values_as_fvecs])
        if len(buffer) == 1000:
            # Buffer looks like this: [["the", FVECS_BINARY], [",", FVECS_BINARY], (...)]
            # Insert into table and clear buffer.
            # Example: "INSERT INTO "SCHEMA"."TABLE" VALUES (?,?)"
            cursor.executemany(f'INSERT INTO "{schema_name}"."{table_name}" VALUES (?,?)', buffer)
            num_inserted += len(buffer)
            print(f'inserted {num_inserted} values into "{schema_name}"."{table_name}"')
            buffer = []
    if len(buffer) > 0:
        cursor.executemany(f'INSERT INTO "{schema_name}"."{table_name}" VALUES (?,?)', buffer)
        num_inserted += len(buffer)
        print(f'inserted {num_inserted} values into "{schema_name}"."{table_name}"')
    print('done')

Starting the Python Script for Uploading Vector Embeddings
----------------------------------------------------------

The Python script uploadscript.py for uploading vector embeddings has the following arguments to be entered:

*   File name and path (for example, /path/to/glove.6B.50d.txt)
    
*   Schema name (for example, GLOVE)
    
*   Table name (for example, DATA50D)
    

The command line execution of the script with the above listed arguments could look as follows:

    python3 uploadscript.py /path/to/glove.6B.50d.txt GLOVE DATA50D

Examples of SELECT Statements on Test Data
------------------------------------------

After the test data have been successfully uploaded to the SAP HANA Cloud database, you can execute SELECT statements to perform similarity searches.

**Note**

The results of the SELECT statements on the test data are only examples and can be different when you execute the SELECT statements.

### L2DISTANCE on glove.6B.50d

The following SELECT statement searches the top 20 similar vectors on the glove.6B.50d data for the word software. The SELECT statement uses the L2DISTANCE function:

    SELECT TOP 20
      R.WORD,
      L2DISTANCE(L.EMBEDDING, R.EMBEDDING) AS SIMILARITY
    FROM
      GLOVE.DATA50D AS L,
      GLOVE.DATA50D AS R
    WHERE
      L.WORD = 'software'
      AND LOWER(R.WORD) NOT LIKE '%software%'
    ORDER BY
      L2DISTANCE(L.EMBEDDING, R.EMBEDDING);

The SELECT statement returns the following rows:

WORD

SIMILARITY

computer

2.9268228181907476

applications

3.287890735221499

hardware

3.380366262421165

multimedia

3.3856324738407158

microsoft

3.4905392983758055

proprietary

3.5293428115092964

desktop

3.6245127383321516

application

3.6461842540610845

web

3.669479692668265

technology

3.6702183659005296

computing

3.67937959002336

user

3.6956175341531536

systems

3.69823122790989

digital

3.7161969308563627

electronic

3.733370721720625

pc

3.7514559144779356

google

3.804377674435872

computers

3.808136991841655

internet

3.812920218900879

networking

3.8159876645606574

### COSINE\_SIMILARITY on glove.6B.50d

The following SELECT statement searches the top 20 similar vectors on the glove.6B.50d data for the word software. The SELECT statement uses the COSINE\_SIMILARITY function:

    SELECT TOP 20
      R.WORD,
      COSINE_SIMILARITY(L.EMBEDDING, R.EMBEDDING) AS SIMILARITY
    FROM
      GLOVE.DATA50D AS L,
      GLOVE.DATA50D AS R
    WHERE
      L.WORD = 'software'
      AND LOWER(R.WORD) NOT LIKE '%software%'
    ORDER BY
      COSINE_SIMILARITY(L.EMBEDDING, R.EMBEDDING) DESC;

**Note**

DESC in the ORDER BY clause is required, because more similar vectors have a higher cosine similarity.

The SELECT statement returns the following rows:

WORD

SIMILARITY

computer

0.8814993499581875

applications

0.841159375285167

hardware

0.8305479227694785

multimedia

0.829623829284579

microsoft

0.8281514640776652

desktop

0.8135049415461005

proprietary

0.8131458638307014

technology

0.8089753491511446

systems

0.8081182123391694

web

0.8033154210783227

digital

0.8023002920244371

application

0.8000610323828329

computers

0.799800820903147

user

0.7997915493305602

computing

0.7994580194739753

internet

0.7970110417560528

electronic

0.7929137334054942

users

0.7920739667161457

pc

0.7898552963213662

networking

0.7853345452356028